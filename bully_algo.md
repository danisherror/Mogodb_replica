Awesome! Let’s build a **term-based Bully Algorithm with syncing logic** in Node.js to handle the master rejoining scenario safely.

---

## What we’ll add:

1. **Term (epoch) tracking** for each DB.
2. Store term info **inside each database** (e.g., a simple `metadata` collection).
3. When a node wants to become master, it:

   * Checks its term against the highest term known.
   * If outdated, it syncs data from current master first, updates term, then can try again later.
4. Election increments the global term.
5. Master notifies slaves of its term and role.

---

## Setup Assumptions:

* Using MongoDB with Mongoose (3 DB connections).
* Each DB has a `Metadata` model with a document that stores current `term`.
* We simulate sync by copying the current master's term to the follower (you can extend this to real data sync).

---

### Step 1: Update schema for `Metadata`

```js
const metadataSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  term: Number,
});

const Metadata = connection.model('Metadata', metadataSchema);
```

---

### Step 2: Full implementation example: `termBullyMongo.js`

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

// Sync data from current master (simulate by copying term)
async function syncDataFromMaster(db, master) {
  console.log(`🔄 Syncing data of ${db.name} from master ${master.name}`);
  // For demo: Just copy master's term to db
  db.term = master.term;
  if (models[db.id]) {
    await models[db.id].Metadata.updateOne({ key: 'term' }, { term: db.term });
  }
  console.log(`✅ Sync complete for ${db.name}, term updated to ${db.term}`);
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
    const canBeMaster = await canBecomeMaster(db);
    if (canBeMaster) {
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
  }, 10000);

  setInterval(async () => {
    await writeData(`Value-${Math.floor(Math.random() * 1000)}`);
  }, 7000);
}

monitor();
```

---

## How to test

1. Update MongoDB URIs as needed.
2. Run `node termBullyMongo.js`.
3. Watch the election and term logs.
4. Stop the master MongoDB instance and see re-election.
5. Restart old master and see sync prevent it from becoming master until caught up.

---

### This setup:

* Protects against stale old masters reclaiming leadership.
* Ensures new master always has highest term.
* Syncs outdated nodes before allowing promotion.
* Demonstrates term-based Bully Algorithm.

---

If you want, I can also help you implement:

* Real data replication between nodes
* Reads from slaves
* Better failure detection and notification

Just say the word!
