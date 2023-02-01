/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import pg from "pg";

const {
  POSTGRES_USER,
  POSTGRES_HOST,
  POSTGRES_PORT,
  POSTGRES_PASSWORD,
  POSTGRES_DB,
} = process.env;

Object.entries({
  POSTGRES_USER,
  POSTGRES_HOST,
  POSTGRES_PORT,
  POSTGRES_PASSWORD,
  POSTGRES_DB,
}).forEach(([key, value]) => {
  if (!value) {
    throw new Error(`Environment variable ${key} is missing`);
  }
});

export const client = new pg.Client({
  database: POSTGRES_DB,
  user: POSTGRES_USER,
  port: parseInt(POSTGRES_PORT!, 10),
  host: POSTGRES_HOST,
  password: POSTGRES_PASSWORD,
});
