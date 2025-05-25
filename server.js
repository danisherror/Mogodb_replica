require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const app = express();
app.use(express.json());

const User = require("./models/User");

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("✅ Connected to MongoDB Atlas replica set"))
.catch(err => console.error("❌ MongoDB connection error:", err));

app.get("/", (req, res) => res.send("API is running"));

app.post("/users", async (req, res) => {
  const user = new User(req.body);
  await user.save();
   console.log("✅ data ")
   console.log(user)
  res.status(201).send(user);
});

app.listen(process.env.PORT, () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});
