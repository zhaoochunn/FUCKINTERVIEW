import test from "node:test";
import assert from "node:assert/strict";
import { samePath, modelsDirFor } from "../src/lib/storage-path.ts";

test("POSIX paths preserve case, Unicode and literal backslashes", () => {
  assert.equal(samePath("/Volumes/Data", "/Volumes/data"), false);
  assert.equal(samePath("/Users/用户/My Data/", "/Users/用户/My Data"), true);
  assert.equal(samePath("/tmp/a\\b", "/tmp/a/b"), false);
  assert.equal(samePath("/", ""), false);
});
test("Windows drive and UNC paths keep case-insensitive separator handling", () => {
  assert.equal(samePath("C:\\Users\\Test\\", "c:/users/test"), true);
  assert.equal(samePath("\\\\HOST\\Share\\Data", "//host/share/data/"), true);
  assert.equal(samePath("C:\\One", "C:\\Two"), false);
});
test("model directory uses the source path style", () => {
  assert.equal(modelsDirFor("/Users/用户/My Data/"), "/Users/用户/My Data/models");
  assert.equal(modelsDirFor("C:\\Data\\"), "C:\\Data\\models");
  assert.equal(modelsDirFor("/tmp/a\\b"), "/tmp/a\\b/models");
  assert.equal(modelsDirFor("/tmp/a\\"), "/tmp/a\\/models");
});
