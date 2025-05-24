To ensure **consistent data across all MongoDB instances** (master and slaves) in your custom Node.js + MongoDB cluster with failover, you need to add **custom data replication logic** to your current setup. MongoDB doesn't automatically replicate between independent instances unless you use **MongoDB replica sets** — but since you want full control, we’ll replicate **via code**.

---

## ✅ Goal

When a write happens on the **master**, it should:

1. Write to its own database.
2. **Replicate the same write** to the other slave nodes' databases.
3. Slaves store the data using their own MongoDB instance.

---

## 🔧 Solution: Custom Data Replication via REST

We'll modify your current setup as follows:

---

## ✅ Step-by-Step Changes

### 1. 📘 Master `/write` Route (Updated)

```js
const slaveNodes = config.nodes.filter(n => n.id !== self.id);

app.post('/write', async (req, res) => {
  if (getRole() !== 'master') {
    return res.status(403).send('Only master can write');
  }

  const { content } = req.body;
  const newData = new Data({ content });
  await newData.save(); // Save to master DB

  // Replicate to slaves
  slaveNodes.forEach(slave => {
    axios.post(`${slave.host}/replicate`, { content }).catch(err => {
      console.error(`[REPLICATION ERROR] Could not replicate to Node ${slave.id}:`, err.message);
    });
  });

  res.send('Data written and replicated');
});
```

---

### 2. 📘 Slave `/replicate` Endpoint

Each slave needs a `/replicate` route to accept data from master:

```js
app.post('/replicate', async (req, res) => {
  const { content } = req.body;

  const newData = new Data({ content });
  await newData.save(); // Save to local slave DB

  res.send('Data replicated');
});
```

> 🔒 **Security Tip:** You may want to verify that only the master can send requests to `/replicate`.

---

### 3. ⚠️ Ensure Write Ordering & Idempotency (Advanced)

To **ensure exactly-once delivery**, you can:

* Use a unique `dataId` for each write
* Check if it already exists before saving on the slave
* Implement retries if replication fails temporarily

Example schema:

```js
const dataSchema = new mongoose.Schema({
  dataId: { type: String, unique: true }, // UUID
  content: String,
  createdAt: { type: Date, default: Date.now }
});
```

---

### 4. ⏳ Handling Delayed Replication

If a slave is down during replication:

* Store the failed messages in memory (or a file/queue)
* Retry sending them every X seconds until success

---

## 📦 Optional: Central Logging or Audit Trail

To verify data consistency, you can:

* Create a `/status` or `/sync-check` route on each node
* Periodically compare document counts or checksums

---

## 🧪 Test Scenario

1. Start all 3 MongoDB instances.
2. Start 3 nodes with unique IDs.
3. Promote one to master (it will happen automatically).
4. Send a POST to the master's `/write` route:

```json
{ "content": "Test Message" }
```

5. Query all nodes via `/read`:

   * Data should appear on all nodes.

---

## ✅ Result

With this in place, your cluster:

* Elects a master
* Writes data via the master only
* Replicates writes to all slave databases
* Maintains data consistency across all nodes

---

## ➕ Do You Want...

* A retry queue for failed replications?
* A Docker-based deployment for all 3 services and DBs?
* A script to automatically verify data consistency?

Let me know and I’ll build that too.
