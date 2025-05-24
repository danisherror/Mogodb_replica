To use the full coding environment with ChatGPT canvas, you'll need to log in to ChatGPT. But no worries — I can still provide everything right here.

Let's build both:

---

## ✅ **Part 1: Full Starter Template**

A Node.js service that can dynamically become a master or slave.

---

### 📦 Step 1: Project Setup

```bash
mkdir distributed-cluster
cd distributed-cluster
npm init -y
npm install express axios mongoose
```

Create folders:

```
mkdir shared
touch config.js server.js leaderElection.js roles.js shared/models/Data.js
```

---

### ⚙️ `config.js`

Define cluster node details and self identity.

```js
module.exports = {
  self: {
    id: 1, // Unique ID for this node (change for each node)
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

### 🧠 `roles.js`

Track current role of the node.

```js
let currentRole = 'slave';

function getRole() {
  return currentRole;
}

function setRole(role) {
  console.log(`[ROLE CHANGE] This node is now: ${role}`);
  currentRole = role;
}

module.exports = { getRole, setRole };
```

---

### 🤖 `leaderElection.js`

Heartbeat and Bully Election logic.

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
        }).catch(() => {
          // no response
        });
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

  Promise.allSettled(
    higherNodes.map(n =>
      axios.post(`${n.host}/election`).then(() => {
        responded = true;
      }).catch(() => { })
    )
  ).then(() => {
    if (!responded) {
      becomeMaster();
    }
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
    axios.post(`${n.host}/new-master`, { id: self.id }).catch(() => { });
  });
}

function setMaster(nodeId) {
  currentMaster = nodes.find(n => n.id === nodeId);
  setRole('slave');
}

module.exports = { startHeartbeat, startElection, setMaster };
```

---

### 🚀 `server.js`

Main app entry.

```js
const express = require('express');
const mongoose = require('mongoose');
const Data = require('./shared/models/Data');
const { self } = require('./config');
const { getRole, setRole } = require('./roles');
const { startHeartbeat, startElection, setMaster } = require('./leaderElection');

const app = express();
app.use(express.json());

mongoose.connect(`mongodb://localhost:2701${self.id}/localdb`);

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.post('/election', (req, res) => {
  console.log(`[ELECTION] Received election msg from lower node`);
  startElection(); // Participate in election
  res.send('OK');
});

app.post('/new-master', (req, res) => {
  const { id } = req.body;
  console.log(`[UPDATE] New master elected: Node ${id}`);
  setMaster(id);
  res.send('ack');
});

app.post('/write', async (req, res) => {
  if (getRole() !== 'master') {
    return res.status(403).send('Only master can write');
  }
  const { content } = req.body;
  const newData = new Data({ content });
  await newData.save();
  res.send('Written by master');
});

app.get('/read', async (req, res) => {
  const data = await Data.find().sort({ createdAt: -1 });
  res.json(data);
});

app.listen(self.port, () => {
  console.log(`Node ${self.id} running on port ${self.port}`);
  setRole('slave'); // default
  startHeartbeat();

  if (self.id === Math.max(...require('./config').nodes.map(n => n.id))) {
    setTimeout(() => {
      console.log('Highest node self-elects');
      startElection();
    }, 2000);
  }
});
```

---

## 🧪 Run 3 Nodes

You’ll need to:

1. Copy the project 3 times (`node1`, `node2`, `node3`)

2. Change:

   * `config.self.id` and `port`
   * MongoDB port (`27011`, `27012`, `27013` for example)

3. Run MongoDB for each:

   ```bash
   mongod --port 27011 --dbpath ./db1
   mongod --port 27012 --dbpath ./db2
   mongod --port 27013 --dbpath ./db3
   ```

4. Start each node:

   ```bash
   node server.js
   ```

---

## ✅ What's Included

* Leader election via Bully Algorithm
* Heartbeat monitoring
* Dynamic master promotion
* Write/read API routing
* MongoDB data storage

---

Would you like me to prepare a **Docker Compose setup** to run all 3 nodes easily?
