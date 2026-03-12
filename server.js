require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.send("Lia backend running");
});

app.post("/chatwoot/webhook", (req, res) => {
  console.log("Webhook recebido do Chatwoot:");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});