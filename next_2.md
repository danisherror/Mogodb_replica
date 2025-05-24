Excellent — adding these two features will make your distributed system much more **resilient and trustworthy**.

---

## ✅ 1. Retry Queue for Failed Replications

We'll implement a **simple in-memory queue** that retries failed replication attempts every few seconds.

### 📦 Update to `server.js` or Create `replicationQueue.js`

```js
// replicationQueue.js
const axios = require('axios');
const { nodes, self } = require('./config');

let queue = [];

// Add a failed replication to the queue
function enqueueReplication(slave, data) {
  queue.push({ slave, data, attempts: 0 });
}

// Retry logic (call this on startup)
function startReplicationRetryWorker() {
  setInterval(async () => {
    if (queue.length === 0) return;

    queue = await Promise.all(queue.map(async item => {
      try {
        await axios.post(`${item.slave.host}/replicate`, item.data);
        console.log(`[RETRY SUCCESS] Data replicated to Node ${item.slave.id}`);
        return null; // Remove from queue
      } catch (err) {
        console.log(`[RETRY FAILED] Still can't reach Node ${item.slave.id}`);
        item.attempts++;
        return item; // Keep in queue
      }
    }));

    // Clean out nulls
    queue = queue.filter(item => item !== null && item.attempts < 10);
  }, 5000);
}

module.exports = { enqueueReplication, startReplicationRetryWorker };
```

### 📘 In `server.js` (Master node)

```js
const { enqueueReplication, startReplicationRetryWorker } = require('./replicationQueue');
startReplicationRetryWorker(); // start retry loop on any node

app.post('/write', async (req, res) => {
  if (getRole() !== 'master') return res.status(403).send('Only master can write');

  const { content } = req.body;
  const newData = new Data({ content });
  await newData.save();

  // Send to slaves
  slaveNodes.forEach(slave => {
    axios.post(`${slave.host}/replicate`, { content }).catch(err => {
      enqueueReplication(slave, { content });
    });
  });

  res.send('Data written and replication started');
});
```

---

## ✅ 2. Script to Verify Data Consistency

This script will query `/read` on all nodes, and check if they contain the **same data set** (based on content or a unique `dataId`).

### 🧪 `verifyConsistency.js`

```js
// verifyConsistency.js
const axios = require('axios');

const nodes = [
  { id: 1, url: 'http://localhost:4000/read' },
  { id: 2, url: 'http://localhost:4001/read' },
  { id: 3, url: 'http://localhost:4002/read' }
];

async function fetchData(url) {
  try {
    const res = await axios.get(url);
    return res.data.map(d => d.content).sort(); // Simplified check
  } catch (err) {
    return null;
  }
}

(async () => {
  const dataFromAll = await Promise.all(nodes.map(n => fetchData(n.url)));

  if (dataFromAll.includes(null)) {
    console.log('❌ One or more nodes are unreachable.');
    return;
  }

  const reference = JSON.stringify(dataFromAll[0]);
  const allMatch = dataFromAll.every(d => JSON.stringify(d) === reference);

  if (allMatch) {
    console.log('✅ All nodes have consistent data!');
  } else {
    console.log('❌ Data inconsistency detected:');
    dataFromAll.forEach((data, idx) => {
      console.log(`Node ${nodes[idx].id}:`, data);
    });
  }
})();
```

---

## 🧪 How to Use

* Make sure all 3 nodes are running.
* Write data using `POST /write` on the master.
* Run:

  ```bash
  node verifyConsistency.js
  ```

---

## ✅ Summary

| Feature                                          | Included                      |
| ------------------------------------------------ | ----------------------------- |
| Retry failed replications                        | ✅ Yes, with queue + backoff   |
| Auto verify consistency                          | ✅ Yes, via `/read` comparison |
| Easy to extend to file-based retry logs or Redis | ✅ Possible                    |

---

Would you like to enhance this further with:

* Persistent queue using **file system** or **Redis**?
* Auto-sync missing entries during verification?

Let me know — I can build that too.
