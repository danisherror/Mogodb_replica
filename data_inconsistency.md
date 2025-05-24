Absolutely! Let’s build a **simple oplog-based incremental replication** demo in Node.js.

---

# What we’ll do:

* When master writes data, it also writes an **operation log** entry (`oplog`).
* Each slave regularly polls the master’s oplog for new ops after its last sync time.
* Slave applies new ops incrementally to keep data consistent.
* For simplicity, all nodes are accessible from this service (simulated).

---

# Code example: `simpleOplogReplication.js`

```js
const mongoose = require('mongoose');

// Simulated DB nodes with their own connections
const databases = [
  { id: 1, name: 'db1', uri: 'mongodb://localhost:27019/db1', role: 'master', connection: null },
  { id: 2, name: 'db2', uri: 'mongodb://localhost:27018/db2', role: 'slave', connection: null, lastSync: null },
  { id: 3, name: 'db3', uri: 'mongodb://localhost:27017/db3', role: 'slave', connection: null, lastSync: null },
];

// Schemas for data and oplog
const dataSchema = new mongoose.Schema({
  data: String,
  createdAt: Date,
});

const oplogSchema = new mongoose.Schema({
  op: String,          // e.g. 'insert'
  dataId: mongoose.Types.ObjectId,
  dataContent: String, // Embedding data for simplicity
  timestamp: { type: Date, default: Date.now },
});

// Models storage: dbId => { DataModel, OplogModel }
const models = {};

// Connect all DBs
async function connectAllDBs() {
  for (const db of databases) {
    if (db.connection) {
      await db.connection.close().catch(() => {});
    }
    try {
      db.connection = await mongoose.createConnection(db.uri, { useNewUrlParser: true, useUnifiedTopology: true });
      models[db.id] = {
        Data: db.connection.model('Data', dataSchema),
        Oplog: db.connection.model('Oplog', oplogSchema),
      };
      console.log(`${db.name} connected`);
    } catch (err) {
      console.log(`${db.name} connection failed`, err.message);
      db.connection = null;
    }
  }
}

// Master write: Insert data + write oplog entry
async function masterWrite(data) {
  const masterDb = databases.find(db => db.role === 'master' && db.connection);
  if (!masterDb) {
    console.log('No master connected');
    return;
  }

  const { Data, Oplog } = models[masterDb.id];

  const newDoc = new Data({ data, createdAt: new Date() });
  await newDoc.save();

  const oplogEntry = new Oplog({
    op: 'insert',
    dataId: newDoc._id,
    dataContent: data,
  });
  await oplogEntry.save();

  console.log(`Master wrote data: "${data}" and oplog entry`);
}

// Slave sync: fetch oplog entries from master after lastSync and apply
async function slaveSync(slaveDb) {
  const masterDb = databases.find(db => db.role === 'master' && db.connection);
  if (!masterDb) {
    console.log('No master connected for syncing');
    return;
  }

  const masterOplog = models[masterDb.id].Oplog;
  const slaveData = models[slaveDb.id].Data;

  // Find ops newer than lastSync
  const lastSync = slaveDb.lastSync || new Date(0);
  const newOps = await masterOplog.find({ timestamp: { $gt: lastSync } }).sort('timestamp');

  if (newOps.length === 0) {
    console.log(`${slaveDb.name} no new ops to sync`);
    return;
  }

  console.log(`${slaveDb.name} syncing ${newOps.length} ops from master`);

  for (const op of newOps) {
    if (op.op === 'insert') {
      // Check if data already exists in slave to avoid duplicates
      const exists = await slaveData.exists({ _id: op.dataId });
      if (!exists) {
        await slaveData.create({
          _id: op.dataId,
          data: op.dataContent,
          createdAt: op.timestamp,
        });
        console.log(`${slaveDb.name} inserted data "${op.dataContent}"`);
      }
    }
    // Extend here for other op types: update, delete
  }

  // Update last sync time
  slaveDb.lastSync = newOps[newOps.length - 1].timestamp;
}

// Periodic slave syncing
function startSlaveSync() {
  for (const db of databases.filter(d => d.role === 'slave')) {
    setInterval(async () => {
      if (!db.connection) return;
      try {
        await slaveSync(db);
      } catch (e) {
        console.error(`${db.name} sync error`, e.message);
      }
    }, 5000);
  }
}

// Demo: periodic writes from master
function startMasterWrites() {
  setInterval(async () => {
    try {
      const val = `Val-${Math.floor(Math.random() * 1000)}`;
      await masterWrite(val);
    } catch (e) {
      console.error('Master write error', e.message);
    }
  }, 7000);
}

async function main() {
  await connectAllDBs();
  startSlaveSync();
  startMasterWrites();
}

main();
```

---

### How it works:

* Master writes data and an oplog entry (includes embedded data).
* Slaves poll master’s oplog for new ops since last sync.
* Slaves apply missing ops by inserting data.
* This keeps slave DBs eventually consistent with master.
* Runs with 3 MongoDB instances at ports 27019 (master), 27018, 27017 (slaves).

---

### To test:

1. Run 3 MongoDB servers locally on ports 27019 (master), 27018, 27017.
2. Save the above as `simpleOplogReplication.js`.
3. Run with `node simpleOplogReplication.js`.
4. Watch console logs showing master writes and slaves syncing new data.

---

### Improvements / Next steps:

* Support update & delete operations.
* Add error handling, retries.
* Use MongoDB change streams for near real-time push instead of polling.
* Conflict resolution if multi-master or network partitions.

---

If you want, I can help you extend this with **update/delete ops** or **push-based replication with change streams** next — just let me know!
