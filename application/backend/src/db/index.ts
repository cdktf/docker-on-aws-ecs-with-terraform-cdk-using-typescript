import { Pool } from "pg";

import { clientConfig } from "./config";

export const db = new Pool(clientConfig);
