const express = require("express");
const cors = require("cors");
const authRoutes = require("./src/routes/auth.routes");
const rateRoutes = require("./src/routes/rate.routes");
const transactionRoutes = require("./src/routes/transaction.routes");
const profileRoutes = require("./src/routes/profile.routes");
const bankAccountRoutes = require("./src/routes/bankAccount.routes");
const banksRoutes = require("./src/routes/banks.routes");
const adminRoutes = require("./src/routes/admin.routes");
const webhookRoutes = require("./src/routes/webhook.routes");
const depositAddressRoutes = require("./src/routes/depositAddress.routes");
const giftCardRoutes = require("./src/routes/giftCard.routes");

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Webhook must be registered before express.json() — needs raw body for signature verification
app.use("/api/v1/webhooks", webhookRoutes);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Naivolt API is running" });
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/rate", rateRoutes);
// Log when a request hits transactions (so we can see if the request reaches the server)
app.use("/api/v1/transactions", (req, res, next) => {
  console.log("[Transactions]", req.method, req.originalUrl, "received");
  next();
});
app.use("/api/v1/transactions", transactionRoutes);
app.use("/api/v1/profile", profileRoutes);
app.use("/api/v1/bank-accounts", bankAccountRoutes);
app.use("/api/v1/banks", banksRoutes);
app.use("/api/v1/deposit-address", depositAddressRoutes);
app.use("/api/v1/gift-cards", giftCardRoutes);
app.use("/api/v1/admin", adminRoutes);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE")
      return res
        .status(400)
        .json({ status: "error", message: "Image must be under 5MB" });
    if (err.code === "LIMIT_UNEXPECTED_FILE")
      return res
        .status(400)
        .json({ status: "error", message: "Unexpected field" });
    return res
      .status(400)
      .json({ status: "error", message: err.message || "File upload failed" });
  }
  console.error("API error:", err);
  const status = err.statusCode || err.status || 500;
  const message = err.message || "Something went wrong";
  return res.status(status).json({ status: "error", message });
});

module.exports = app;
