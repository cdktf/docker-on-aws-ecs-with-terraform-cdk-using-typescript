/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Pool } from "pg";

import { clientConfig } from "./config";

export const db = new Pool(clientConfig);
