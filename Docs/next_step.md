To access the full code in an interactive environment, you’ll need to log in to ChatGPT and use the canvas feature.

For now, here’s the complete **copy-paste-ready Node.js codebase** to create your robust master-slave cluster with failover, retry queue, and consistency checker.

---

## 📁 Project Structure

```
distributed-cluster/
├── config.js
├── server.js
├── leaderElection.js
├── roles.js
├── replicationQueue.js
├── verifyConsistency.js
└── shared/
    └── models/
        └── Data.js
```

---

### 🔧 `config.js`

```js
module.exports = {
  self: {
    id: 1, // Change this to 2 or 3 for other nodes
    port: 4000,
    host: 'http://localhost:4000',
  },
  nodes: [
    { id: 1, host: 'http://localhost:4000' },
    { id: 2, host: 'http://localhost:4001' },
    { id: 3, host: 'http://localhost:4002' }
  ],
  heartbeatInterval: 3000,
  heartbeatTimeout: 5000
};
```

---

### 🧠 `roles.js`

```js
let currentRole = 'slave';

function getRole() {
  return currentRole;
}

function setRole(role) {
  console.log(`[ROLE] Switched to: ${role}`);
  currentRole = role;
}

module.exports = { getRole, setRole };
```

---

### 📘 `shared/models/Data.js`

```js
const mongoose = require('mongoose');

const dataSchema = new mongoose.Schema({
  content: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Data', dataSchema);
```

---

### 🔁 `replicationQueue.js`

```js
const axios = require('axios');
const { nodes, self } = require('./config');

let queue = [];

function enqueueReplication(slave, data) {
  queue.push({ slave, data, attempts: 0 });
}

function startReplicationRetryWorker() {
  setInterval(async () => {
    if (queue.length === 0) return;

    queue = await Promise.all(queue.map(async item => {
      try {
        await axios.post(`${item.slave.host}/replicate`, item.data);
        console.log(`[RETRY SUCCESS] Replicated to Node ${item.slave.id}`);
        return null;
      } catch {
        item.attempts++;
        return item;
      }
    }));

    queue = queue.filter(item => item !== null && item.attempts < 10);
  }, 5000);
}

module.exports = { enqueueReplication, startReplicationRetryWorker };
```

---

### 🗳️ `leaderElection.js`

```js
const axios = require('axios');
const { self, nodes, heartbeatInterval, heartbeatTimeout } = require('./config');
const { getRole, setRole } = require('./roles');

let currentMaster = null;
let lastHeartbeat = {};

function startHeartbeat() {
  setInterval(() => {
    nodes.forEach(node => {
      if (node.id !== self.id) {
        axios.get(`${node.host}/ping`).then(() => {
          lastHeartbeat[node.id] = Date.now();
        }).catch(() => {});
      }
    });

    detectFailure();
  }, heartbeatInterval);
}

function detectFailure() {
  if (currentMaster && currentMaster.id !== self.id) {
    const last = lastHeartbeat[currentMaster.id] || 0;
    if (Date.now() - last > heartbeatTimeout) {
      console.log(`[FAILURE] Master ${currentMaster.id} down. Starting election...`);
      startElection();
    }
  }
}

function startElection() {
  const higherNodes = nodes.filter(n => n.id > self.id);
  if (higherNodes.length === 0) {
    becomeMaster();
    return;
  }

  let responded = false;

  Promise.allSettled(higherNodes.map(n =>
    axios.post(`${n.host}/election`).then(() => { responded = true; })
  )).then(() => {
    if (!responded) becomeMaster();
  });
}

function becomeMaster() {
  setRole('master');
  currentMaster = self;
  notifyOthers();
}

function notifyOthers() {
  const slaves = nodes.filter(n => n.id !== self.id);
  slaves.forEach(n => {
    axios.post(`${n.host}/new-master`, { id: self.id }).catch(() => {});
  });
}

function setMaster(id) {
  currentMaster = nodes.find(n => n.id === id);
  setRole('slave');
}

module.exports = { startHeartbeat, startElection, setMaster };
```

---

### 🚀 `server.js`

```js
const express = require('express');
const mongoose = require('mongoose');
const Data = require('./shared/models/Data');
const { self, nodes } = require('./config');
const { getRole, setRole } = require('./roles');
const { startHeartbeat, startElection, setMaster } = require('./leaderElection');
const { enqueueReplication, startReplicationRetryWorker } = require('./replicationQueue');

const app = express();
app.use(express.json());

mongoose.connect(`mongodb://localhost:2701${self.id}/localdb`);

const slaveNodes = nodes.filter(n => n.id !== self.id);

app.get('/ping', (req, res) => res.send('pong'));

app.post('/election', (req, res) => {
  console.log(`[ELECTION] Received election msg`);
  startElection();
  res.send('OK');
});

app.post('/new-master', (req, res) => {
  const { id } = req.body;
  console.log(`[MASTER UPDATE] New master: Node ${id}`);
  setMaster(id);
  res.send('ack');
});

app.post('/write', async (req, res) => {
  if (getRole() !== 'master') return res.status(403).send('Only master can write');

  const { content } = req.body;
  const newData = new Data({ content });
  await newData.save();

  slaveNodes.forEach(slave => {
    axios.post(`${slave.host}/replicate`, { content }).catch(() => {
      enqueueReplication(slave, { content });
    });
  });

  res.send('Written and replicating');
});

app.post('/replicate', async (req, res) => {
  const { content } = req.body;
  const newData = new Data({ content });
  await newData.save();
  res.send('Replicated');
});

app.get('/read', async (req, res) => {
  const data = await Data.find().sort({ createdAt: -1 });
  res.json(data);
});

app.listen(self.port, () => {
  console.log(`Node ${self.id} running on port ${self.port}`);
  setRole('slave');
  startHeartbeat();
  startReplicationRetryWorker();

  const highestId = Math.max(...nodes.map(n => n.id));
  if (self.id === highestId) {
    setTimeout(() => {
      console.log('Self-initiating election (highest ID)');
      startElection();
    }, 2000);
  }
});
```

---

### 🔍 `verifyConsistency.js`

```js
const axios = require('axios');

const nodes = [
  { id: 1, url: 'http://localhost:4000/read' },
  { id: 2, url: 'http://localhost:4001/read' },
  { id: 3, url: 'http://localhost:4002/read' }
];

async function fetchData(url) {
  try {
    const res = await axios.get(url);
    return res.data.map(d => d.content).sort();
  } catch {
    return null;
  }
}

(async () => {
  const allData = await Promise.all(nodes.map(n => fetchData(n.url)));

  if (allData.includes(null)) {
    console.log('❌ One or more nodes are unreachable');
    return;
  }

  const reference = JSON.stringify(allData[0]);
  const consistent = allData.every(d => JSON.stringify(d) === reference);

  if (consistent) {
    console.log('✅ All nodes are consistent!');
  } else {
    console.log('❌ Inconsistency detected:');
    allData.forEach((d, i) => console.log(`Node ${nodes[i].id}:`, d));
  }
})();
```

---

## 🧪 Setup Instructions

1. Duplicate this folder 3 times: `node1/`, `node2/`, `node3/`
2. In each copy, change:

   * `config.self.id` to `1`, `2`, or `3`
   * `config.self.port` and `host`
   * MongoDB port: `27011`, `27012`, `27013`
3. Start MongoDB:

```bash
mongod --port 27011 --dbpath ./db1
mongod --port 27012 --dbpath ./db2
mongod --port 27013 --dbpath ./db3
```

4. Start servers:

```bash
node server.js
```

5. Test:

   * POST to `/write` on the master
   * Run `node verifyConsistency.js` to check data match

---

Would you like a Docker Compose file to run all 3 nodes and MongoDB containers automatically?
