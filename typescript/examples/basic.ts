import { credentialHash } from "hushclient-sdk";
import { makeClient } from "./config.js";

const client = makeClient();
console.log("Health:", await client.health());
const digest = credentialHash("testusername1@nwebbed.com", "testpassword1");
console.log("Hash check:", await client.checkHash(digest));
console.log("Credential check:", await client.check("testusername1@nwebbed.com", "testpassword1"));
console.log("Credential batch:", await client.checkBatch([
  { username: "testusername1@nwebbed.com", password: "testpassword1" },
  { username: "testusername2@nwebbed.com", password: "testpassword2" },
]));
console.log("Hash batch:", await client.checkHashBatch([digest]));

