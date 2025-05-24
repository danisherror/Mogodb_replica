Sure! Here's a **Node.js Bully Algorithm example with real MongoDB connections using Mongoose**, managing **3 MongoDB instances** as separate databases. It elects the highest-priority **master** and routes all writes to it, while others become **slaves**.

---

# Step-by-step

* You have 3 MongoDB connection URIs (e.g. 3 different instances or clusters).
* Each MongoDB instance is represented by a connection and a priority (ID).
* The Node.js service monitors these DBs, elects a master using Bully Algorithm.
* Writes go only to the master.
* Slaves can be used for reads or standby.

---

## Prerequisites

```bash
npm init -y
npm install mongoose
```

Make sure you have 3 MongoDB instances running or accessible, and update connection URIs accordingly.

---

## Complete Code: `bullyMongo.js`

```js
const mongoose = require('mongoose');

// Replace these URIs with your actual MongoDB connection strings
const databases = [
  { id: 3, name: 'db3', uri: 'mongodb://localhost:27017/db3', role: 'unknown', alive: false, connection: null },
  { id: 2, name: 'db2', uri: 'mongodb://localhost:27018/db2', role: 'unknown', alive: false, connection: null },
  { id: 1, name: 'db1', uri: 'mongodb://localhost:27019/db1', role: 'unknown', alive: false, connection: null },
];

let coordinator = null;

// Simple schema to test writes
const testSchema = new mongoose.Schema({
  data: String,
  createdAt: Date,
});

// Model map by DB id
const models = {};

// Try to connect to each DB and update status
async function checkDatabasesHealth() {
  console.log('\n📡 Checking database health...');
  for (let db of databases) {
    if (db.connection) {
      // Close previous connection before reconnecting
      await db.connection.disconnect().catch(() => {});
    }
    try {
      db.connection = await mongoose.createConnection(db.uri, { useNewUrlParser: true, useUnifiedTopology: true });
      models[db.id] = db.connection.model('Test', testSchema);
      db.alive = true;
      console.log(` - ${db.name} connected ✅`);
    } catch (err) {
      db.alive = false;
      db.connection = null;
      console.log(` - ${db.name} connection failed ❌`);
    }
  }

  if (!coordinator || !coordinator.alive) {
    console.log('🚨 Coordinator down or not set, starting election...');
    electCoordinator();
  } else {
    console.log(`Current coordinator: ${coordinator.name}`);
  }
}

// Bully algorithm: elect highest alive DB as master
function electCoordinator() {
  const aliveDbs = databases.filter(db => db.alive);
  if (aliveDbs.length === 0) {
    console.log('❌ No alive databases found!');
    coordinator = null;
    return;
  }

  const newCoordinator = aliveDbs.reduce((max, db) => (db.id > max.id ? db : max));
  coordinator = newCoordinator;
  coordinator.role = 'master';

  // Set others as slaves
  databases.forEach(db => {
    if (db.id !== coordinator.id && db.alive) {
      db.role = 'slave';
      console.log(`🔔 ${db.name} is now slave.`);
    }
  });

  console.log(`🏆 New coordinator elected: ${coordinator.name}`);
}

// Write data ONLY to the master
async function writeData(data) {
  if (!coordinator || !coordinator.alive) {
    console.log('❌ No coordinator available. Cannot write data.');
    return;
  }

  try {
    const Model = models[coordinator.id];
    if (!Model) {
      console.log('❌ Model not found for coordinator DB');
      return;
    }
    const doc = new Model({ data, createdAt: new Date() });
    await doc.save();
    console.log(`📝 Written data to ${coordinator.name}:`, data);
  } catch (err) {
    console.log('❌ Write failed:', err.message);
  }
}

async function startMonitoring() {
  await checkDatabasesHealth();

  // Periodically check DB health every 10 seconds
  setInterval(async () => {
    await checkDatabasesHealth();
  }, 10000);

  // Periodic writes every 7 seconds
  setInterval(async () => {
    await writeData(`RandomValue-${Math.floor(Math.random() * 1000)}`);
  }, 7000);
}

startMonitoring();
```

---

### How to run?

1. Make sure 3 MongoDB instances are running on ports `27017`, `27018`, `27019`, or update the URIs accordingly.
2. Save the code above as `bullyMongo.js`
3. Run:

```bash
node bullyMongo.js
```

---

### What you should see:

* Each DB connection success/failure.
* Master election logs.
* Writes going only to master DB.
* If master DB goes down (simulate by stopping that MongoDB instance), election triggers and new master is elected.

---

### Note:

* This example uses **Mongoose `createConnection`** for multiple DB connections.
* In production, replace random failure simulation with real health checks.
* This does **not implement data replication** — just leader election and routing.

---

If you want, I can help you extend this with **read from slaves**, or setup **automatic failover detection**. Just ask!
