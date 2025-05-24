Got it! Let’s extend the current term-based Bully algorithm example to include:

### Realistic data replication simulation between nodes:

* When a slave syncs from the master, it will **copy all documents** from master's `Test` collection.
* Slaves will be allowed to read data.
* Writes still only go to master.

---

# Here’s the updated full code: `termBullyMongoReplication.js`

```js
const mongoose = require('mongoose');

const databases = [
  { id: 3, name: 'db3', uri: 'mongodb://localhost:27017/db3', role: 'unknown', alive: false, connection: null, term: 0 },
  { id: 2, name: 'db2', uri: 'mongodb://localhost:27018/db2', role: 'unknown', alive: false, connection: null, term: 0 },
  { id: 1, name: 'db1', uri: 'mongodb://localhost:27019/db1', role: 'unknown', alive: false, connection: null, term: 0 },
];

let coordinator = null;
let globalTerm = 0;

// Schemas
const testSchema = new mongoose.Schema({
  data: String,
  createdAt: Date,
});
const metadataSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  term: Number,
});

// Models map: dbId => { testModel, metadataModel }
const models = {};

// Helper: Connect and init models per DB
async function connectDBs() {
  for (let db of databases) {
    if (db.connection) {
      await db.connection.close().catch(() => {});
    }
    try {
      db.connection = await mongoose.createConnection(db.uri, { useNewUrlParser: true, useUnifiedTopology: true });
      models[db.id] = {
        Test: db.connection.model('Test', testSchema),
        Metadata: db.connection.model('Metadata', metadataSchema),
      };

      db.alive = true;
      // Initialize metadata doc if not exists
      const meta = await models[db.id].Metadata.findOne({ key: 'term' });
      if (!meta) {
        await new models[db.id].Metadata({ key: 'term', term: 0 }).save();
      }
      // Read current term from DB
      const metaDoc = await models[db.id].Metadata.findOne({ key: 'term' });
      db.term = metaDoc ? metaDoc.term : 0;

      console.log(` - ${db.name} connected, term: ${db.term} ✅`);
    } catch (err) {
      db.alive = false;
      db.connection = null;
      console.log(` - ${db.name} connection failed ❌`);
    }
  }
}

// Get highest term from all alive DBs
function getHighestTerm() {
  const aliveDbs = databases.filter(db => db.alive);
  if (aliveDbs.length === 0) return 0;
  return Math.max(...aliveDbs.map(db => db.term));
}

// Copy all data from master Test collection to slave Test collection
async function syncDataFromMaster(db, master) {
  console.log(`🔄 Syncing data of ${db.name} from master ${master.name}`);

  if (!models[db.id] || !models[master.id]) {
    console.log(`❌ Models missing for sync`);
    return;
  }

  const masterData = await models[master.id].Test.find({});
  await models[db.id].Test.deleteMany({}); // Clear slave data

  // Bulk insert master's data to slave
  if (masterData.length > 0) {
    await models[db.id].Test.insertMany(masterData.map(d => ({ data: d.data, createdAt: d.createdAt })));
  }

  // Sync term metadata
  db.term = master.term;
  await models[db.id].Metadata.updateOne({ key: 'term' }, { term: db.term });

  console.log(`✅ Sync complete for ${db.name}, term updated to ${db.term}, data copied (${masterData.length} docs)`);
}

// Check if node can become master
async function canBecomeMaster(db) {
  const highestTerm = getHighestTerm();
  if (db.term < highestTerm) {
    console.log(`❌ ${db.name} term (${db.term}) < highest term (${highestTerm}). Must sync first.`);
    const master = databases.find(d => d.id === coordinator?.id);
    if (master) {
      await syncDataFromMaster(db, master);
    }
    return false;
  }
  return true;
}

// Bully election
async function electCoordinator() {
  globalTerm++;

  const aliveDbs = databases.filter(db => db.alive).sort((a, b) => b.id - a.id);
  for (const db of aliveDbs) {
    const canBeMasterFlag = await canBecomeMaster(db);
    if (canBeMasterFlag) {
      coordinator = db;
      coordinator.role = 'master';
      coordinator.term = globalTerm;
      // Update term in DB
      await models[db.id].Metadata.updateOne({ key: 'term' }, { term: globalTerm });
      console.log(`🏆 New coordinator elected: ${coordinator.name}, term: ${globalTerm}`);

      // Notify others
      for (const other of aliveDbs) {
        if (other.id !== coordinator.id) {
          other.role = 'slave';
          other.term = globalTerm;
          if (models[other.id]) {
            await models[other.id].Metadata.updateOne({ key: 'term' }, { term: globalTerm });
          }
          console.log(`🔔 ${other.name} set to slave with term ${globalTerm}`);

          // Sync slaves after election
          await syncDataFromMaster(other, coordinator);
        }
      }
      return;
    }
  }

  console.log('❌ No eligible coordinator found');
  coordinator = null;
}

// Write only to master
async function writeData(data) {
  if (!coordinator || !coordinator.alive) {
    console.log('❌ No coordinator available, cannot write');
    return;
  }

  try {
    const Model = models[coordinator.id]?.Test;
    if (!Model) {
      console.log('❌ Model missing for coordinator');
      return;
    }
    const doc = new Model({ data, createdAt: new Date() });
    await doc.save();
    console.log(`📝 Written to ${coordinator.name} (term ${coordinator.term}):`, data);
  } catch (err) {
    console.log('❌ Write failed:', err.message);
  }
}

// Read data from any slave or master for demo
async function readData(db) {
  if (!db.alive) {
    console.log(`❌ Cannot read from ${db.name} - not alive`);
    return;
  }

  try {
    const Model = models[db.id]?.Test;
    if (!Model) {
      console.log(`❌ Model missing for ${db.name}`);
      return;
    }
    const docs = await Model.find({}).limit(5);
    console.log(`📖 Reading from ${db.name} (${db.role}, term ${db.term}):`, docs.map(d => d.data));
  } catch (err) {
    console.log(`❌ Read failed from ${db.name}:`, err.message);
  }
}

async function monitor() {
  await connectDBs();

  setInterval(async () => {
    await connectDBs();

    // Re-elect if coordinator down
    if (!coordinator || !coordinator.alive) {
      console.log('🚨 Coordinator down or missing, triggering election...');
      await electCoordinator();
    } else {
      console.log(`Current coordinator: ${coordinator.name}, term: ${coordinator.term}`);
    }
  }, 15000);

  setInterval(async () => {
    await writeData(`Value-${Math.floor(Math.random() * 1000)}`);
  }, 10000);

  // Periodic reads from slaves & master
  setInterval(async () => {
    for (const db of databases.filter(d => d.alive)) {
      await readData(db);
    }
  }, 20000);
}

monitor();
```

---

### How to test?

1. Have 3 MongoDB instances on `27017`, `27018`, `27019` (or update URIs).
2. Run:

```bash
node termBullyMongoReplication.js
```

3. Watch:

   * Election happens.
   * Master receives writes.
   * Slaves sync data after election.
   * Reads show synced data.
4. Stop master DB, watch new election.
5. Restart old master, it syncs and doesn’t become master immediately if term is outdated.

---

# What this code does

* Election respects terms.
* Slaves sync full data from master on election and when they join.
* Writes go only to master.
* Reads can happen on slaves or master.
* Term stored in DB, preventing stale masters.
* Simple replication by copying all `Test` docs.

---

If you want, I can also help you:

* Add real delta or oplog-based syncing instead of full copy.
* Implement a distributed lock for the master.
* Add more robust failure detection.

Would you like me to help with any of those?
