require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const PORT = 3000;

app.use(bodyParser.json());

const databases = [
  { id: 2, name: "db3", uri: process.env.MONGO_URI, role: "unknown", alive: false, connection: null, term: 0 },
  { id: 1, name: "db2", uri: process.env.MONGO_URI_1, role: "unknown", alive: false, connection: null, term: 0 },
];

let coordinator = null;
let globalTerm = 0;

const testSchema = new mongoose.Schema({ data: String, createdAt: Date });
const metadataSchema = new mongoose.Schema({ key: { type: String, unique: true }, term: Number });

const models = {};
function waitForConnection(connection) {
  return new Promise((resolve, reject) => {
    if (connection.readyState === 1) {
      return resolve();
    }
    connection.once('open', () => resolve());
    connection.once('error', err => reject(err));
  });
}

async function connectDBs() {
  for (let db of databases) {
    if (db.connection) {
      await db.connection.close().catch(() => {});
    }
    try {
      db.connection = await mongoose.createConnection(db.uri);

      await waitForConnection(db.connection);  // <-- Wait here!

      models[db.id] = {
        Test: db.connection.model("Test", testSchema),
        Metadata: db.connection.model("Metadata", metadataSchema),
      };

      // Test a simple query
      await models[db.id].Metadata.findOne({ key: "term" }).lean();

      db.alive = true;

      let meta = await models[db.id].Metadata.findOne({ key: "term" });
      if (!meta) {
        meta = await new models[db.id].Metadata({ key: "term", term: 0 }).save();
      }
      db.term = meta.term;

      console.log(` - ${db.name} connected, term: ${db.term} ✅`);
    } catch (err) {
      db.alive = false;
      db.connection = null;
      console.log(` - ${db.name} connection failed ❌`, err.message);
    }
  }
}


function getHighestTerm() {
  const aliveDbs = databases.filter((db) => db.alive);
  return aliveDbs.length === 0 ? 0 : Math.max(...aliveDbs.map((db) => db.term));
}

async function syncDataFromMaster(db, master) {
  console.log(`🔄 Syncing ${db.name} from master ${master.name}`);
  if (!models[db.id] || !models[master.id]) return;

  const masterData = await models[master.id].Test.find({});
  await models[db.id].Test.deleteMany({});
  if (masterData.length > 0) {
    await models[db.id].Test.insertMany(masterData.map((d) => ({ data: d.data, createdAt: d.createdAt })));
  }

  db.term = master.term;
  await models[db.id].Metadata.updateOne({ key: "term" }, { term: db.term });
  console.log(`✅ ${db.name} synced. Term updated to ${db.term}`);
}

async function canBecomeMaster(db) {
  const highestTerm = getHighestTerm();
  if (db.term < highestTerm) {
    console.log(`❌ ${db.name} term too low. Syncing...`);
    const master = databases.find((d) => d.id === coordinator?.id);
    if (master) await syncDataFromMaster(db, master);
    return false;
  }
  return true;
}

async function electCoordinator() {
  globalTerm++;
  const aliveDbs = databases.filter((db) => db.alive).sort((a, b) => b.id - a.id);
  for (const db of aliveDbs) {
    if (await canBecomeMaster(db)) {
      coordinator = db;
      coordinator.role = "master";
      coordinator.term = globalTerm;
      await models[db.id].Metadata.updateOne({ key: "term" }, { term: globalTerm });
      console.log(`🏆 Elected: ${coordinator.name}, term ${globalTerm}`);

      for (const other of aliveDbs) {
        if (other.id !== db.id) {
          other.role = "slave";
          other.term = globalTerm;
          await models[other.id].Metadata.updateOne({ key: "term" }, { term: globalTerm });
          await syncDataFromMaster(other, db);
        }
      }
      return;
    }
  }
  console.log("❌ No eligible coordinator found");
  coordinator = null;
}

async function monitor() {
  await connectDBs();
  await electCoordinator();

  setInterval(async () => {
    await connectDBs();
    if (!coordinator || !coordinator.alive) {
      console.log("🚨 Coordinator down, triggering election...");
      await electCoordinator();
    } else {
      console.log(`💡 Current coordinator: ${coordinator.name}, term ${coordinator.term}`);
    }
  }, 15000);
}

monitor();

app.post("/api/write", async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "Data is required" });

  if (!coordinator || !coordinator.alive) return res.status(500).json({ error: "No coordinator available" });

  try {
    const newDoc = { data, createdAt: new Date() };
    const MasterModel = models[coordinator.id]?.Test;
    const savedDoc = await new MasterModel(newDoc).save();

    const slaves = databases.filter((d) => d.alive && d.id !== coordinator.id);
    for (const slave of slaves) {
      const SlaveModel = models[slave.id]?.Test;
      if (SlaveModel) {
        try {
          await new SlaveModel(savedDoc.toObject()).save();
          console.log(`🛰️ Propagated to ${slave.name}`);
        } catch (err) {
          console.log(`❌ Failed to write to ${slave.name}: ${err.message}`);
        }
      }
    }

    return res.status(201).json({ message: `Written to ${coordinator.name}`, term: coordinator.term });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/read/:dbId", async (req, res) => {
  const dbId = parseInt(req.params.dbId);
  const db = databases.find((d) => d.id === dbId);

  if (!db || !db.alive) return res.status(404).json({ error: "Database not found or not alive" });

  try {
    const Model = models[db.id]?.Test;
    const docs = await Model.find({}).limit(10);
    return res.status(200).json({
      from: db.name,
      role: db.role,
      term: db.term,
      data: docs.map((d) => ({ data: d.data, createdAt: d.createdAt })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Health & Role Status
app.get("/api/status", (req, res) => {
  res.json(
    databases.map((db) => ({
      id: db.id,
      name: db.name,
      alive: db.alive,
      role: db.role,
      term: db.term,
      isCoordinator: coordinator?.id === db.id,
    }))
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
