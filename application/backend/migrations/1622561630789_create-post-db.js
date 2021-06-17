/* eslint-disable camelcase */
const PgLiteral = require("node-pg-migrate").PgLiteral;

exports.shorthands = {
  createdAt: {
    type: "timestamp",
    notNull: true,
    default: new PgLiteral("current_timestamp"),
  },
};

exports.up = (pgm, run) => {
  pgm.createExtension("uuid-ossp");
  pgm.createTable(
    { name: "posts" },
    {
      id: {
        type: "uuid",
        primaryKey: true,
        default: pgm.func("uuid_generate_v4 ()"),
      },
      content: { type: "varchar(1000)", notNull: true },
      author: { type: "varchar(1000)", notNull: true },
      postedAt: "createdAt",
    }
  );
  run();
};

exports.down = (pgm, run) => {
  pgm.dropTable("posts");
  pgm.dropExtension("uuid-ossp");
  run();
};
