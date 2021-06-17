import express from "express";
import cors from "cors";
import { db } from "./db";
import { dbMigrationDone } from "./db/migration";

const app = express();
const port = parseInt(process.env.PORT || "4000");

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get("/", (_req, res) => {
  res.sendStatus(200);
});

app.get("/ready", async (_req, res) => {
  await dbMigrationDone;
  res.sendStatus(200);
});

const applicationRouter = express.Router();

applicationRouter.get("/posts", async (_req, res) => {
  try {
    await dbMigrationDone;
    const { rows } = await db.query("SELECT id,content FROM posts");

    res.status(200).json({
      data: rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.toString() });
  }
});

applicationRouter.get("/posts/:id/detail", async (req, res) => {
  await dbMigrationDone;

  const { rows } = await db.query("SELECT * FROM posts WHERE id = $1", [
    req.params.id,
  ]);

  res.json(rows[0]);
});

applicationRouter.post("/posts", async (req, res) => {
  const { content, author } = req.body;
  await dbMigrationDone;
  await db.query("INSERT INTO posts (content, author) VALUES ($1, $2)", [
    content,
    author,
  ]);
  res.sendStatus(201);
});

app.use("/backend", applicationRouter);

app.listen(port, () => {
  console.log(`Started at http://localhost:${port}`);
});
