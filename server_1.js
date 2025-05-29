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
        if (connection.readyState === 1) return resolve();

        const onReady = () => {
            cleanup();
            resolve();
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            connection.removeListener('connected', onReady);
            connection.removeListener('open', onReady);
            connection.removeListener('error', onError);
        };

        connection.once('connected', onReady);
        connection.once('open', onReady);
        connection.once('error', onError);
    });
}


async function connectDBs() {
    let master = databases.find((db) => db.role === "master");
    if (master) {
        for (let db of databases) {
            if (!db.alive) {
                try {
                    db.connection = await mongoose.createConnection(db.uri);
                    await waitForConnection(db.connection);
                    console.log("connectDB-1")
                    models[db.id] = {
                        Test: db.connection.model("Test", testSchema),
                        Metadata: db.connection.model("Metadata", metadataSchema),
                    };
                    console.log("connectDB-2")
                    await models[db.id].Metadata.findOne({ key: "term" }).lean();
                    console.log("connectDB-3")
                    db.alive = true;

                    // Sync from master
                    await syncDataFromMaster(db, master);
                    console.log("connectDB-4")
                    console.log(` - ${db.name} reconnected and synced ✅`);
                } catch (err) {
                    db.alive = false;
                    db.connection = null;
                    console.log(` - ${db.name} reconnection failed ❌`, err.message);
                }
            }
            else {
                try {
                    db.connection = await mongoose.createConnection(db.uri);
                    await waitForConnection(db.connection);
                    console.log(` - ${db.name} connected, term: ${db.term} ✅`);
                } catch (err) {
                    db.alive = false;
                    db.connection = null;
                    db.role= "unknown"
                    console.log(` - ${db.name} connection failed ❌`, err.message);
                }
            }
        }
        return;
    }

    // Now connect or reconnect all nodes fresh, updating models & terms
    for (let db of databases) {
        try {
            db.connection = await mongoose.createConnection(db.uri);
            await waitForConnection(db.connection);

            models[db.id] = {
                Test: db.connection.model("Test", testSchema),
                Metadata: db.connection.model("Metadata", metadataSchema),
            };

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
            db.role= "unknown"
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
    console.log("syncDataFromMaster-1")
    if (db.id === master.id) {
        console.log(`⏭️ Skipping sync: ${db.name} is master`);
        return;
    }
    console.log("syncDataFromMaster-2")
    if (!models[db.id] || !models[master.id]) return;
    console.log("syncDataFromMaster-3")
    const masterData = await models[master.id].Test.find({});
    console.log("syncDataFromMaster-4")
    await models[db.id].Test.deleteMany({});
    console.log("syncDataFromMaster-5")
    if (masterData.length > 0) {
        await models[db.id].Test.insertMany(masterData.map((d) => ({ data: d.data, createdAt: d.createdAt })));
    }
    console.log("syncDataFromMaster-6")

    db.term = master.term;
    console.log("syncDataFromMaster-7")
    await models[db.id].Metadata.updateOne({ key: "term" }, { term: db.term });
    console.log(`✅ ${db.name} synced. Term updated to ${db.term}`);
}

async function canBecomeMaster(db) {
    const highestTerm = getHighestTerm();
    console.log(` - ${db.name} term ${db.term}, highest term: ${highestTerm}`);
    if (db.term < highestTerm) {
        console.log(`❌ ${db.name} term too low. Syncing...`);
        const master = databases.find((d) => d.id === coordinator?.id);
        console.log("canBecomeMaster-1")
        if (master) await syncDataFromMaster(db, master);
        return false;
    }
    return true;
}

async function electCoordinator() {
    globalTerm++;
    console.log(`\n🔎 Starting election, globalTerm now: ${globalTerm}`);

    const aliveDbs = databases.filter((db) => db.alive).sort((a, b) => b.id - a.id);
    for (const db of aliveDbs) {
        console.log(`Checking if ${db.name} can become master (term: ${db.term})`);
        if (await canBecomeMaster(db)) {
            coordinator = db;
            coordinator.role = "master";
            coordinator.term = globalTerm;
            await models[db.id].Metadata.updateOne({ key: "term" }, { term: globalTerm }, { upsert: true });
            console.log(`🏆 Elected: ${coordinator.name}, term ${globalTerm}`);

            for (const other of aliveDbs) {
                if (other.id !== db.id) {
                    other.role = "slave";
                    other.term = globalTerm;
                    await models[other.id].Metadata.updateOne({ key: "term" }, { term: globalTerm }, { upsert: true });
                    console.log("electCoordinator-1")
                    await syncDataFromMaster(other, db);
                }
            }
            return;
        } else {
            console.log(`${db.name} cannot become master.`);
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
                    slave.alive = false;
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

app.put("/api/update/:id", async (req, res) => {
    const { id } = req.params;
    const { data } = req.body;

    if (!data) return res.status(400).json({ error: "Data is required" });
    if (!coordinator || !coordinator.alive) return res.status(500).json({ error: "No coordinator available" });

    try {
        const MasterModel = models[coordinator.id]?.Test;

        // Update in master
        const updatedDoc = await MasterModel.findByIdAndUpdate(id, { data }, { new: true });

        if (!updatedDoc) return res.status(404).json({ error: "Document not found in master" });

        // Propagate update to slaves
        const slaves = databases.filter((d) => d.alive && d.id !== coordinator.id);
        for (const slave of slaves) {
            try {
                const SlaveModel = models[slave.id]?.Test;
                if (SlaveModel) {
                    await SlaveModel.findByIdAndUpdate(id, { data }, { new: true });
                    console.log(`🛰️ Updated on ${slave.name}`);
                }
            } catch (err) {
                slave.alive = false;
                console.log(`❌ Failed to update ${slave.name}: ${err.message}`);
            }
        }

        return res.status(200).json({ message: "Update successful", updated: updatedDoc });
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
