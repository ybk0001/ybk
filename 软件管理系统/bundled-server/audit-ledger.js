const crypto = require("crypto");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => key !== "_version" && key !== "entryHash").map(key => [key, stableValue(value[key])]));
}

function entryHash(entry) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(entry))).digest("hex");
}

function createEntry(input, rows = [], head = null) {
  const previous = rows.find(row => row.entryHash) || head;
  const entry = {
    ...input,
    sequence: Number(previous?.sequence || 0) + 1,
    previousHash: previous?.entryHash || "",
    integrityVersion: 1
  };
  return { ...entry, entryHash: entryHash(entry) };
}

function verify(rows = [], head = null) {
  const sealed = rows.filter(row => row.entryHash);
  const legacyCount = rows.length - sealed.length;
  const errors = [];
  let sawLegacy = false;
  for (const row of rows) {
    if (!row.entryHash) sawLegacy = true;
    else if (sawLegacy) errors.push({ code: "sealed_after_legacy", id: row.id });
  }
  for (let index = 0; index < sealed.length; index += 1) {
    const row = sealed[index];
    if (entryHash(row) !== row.entryHash) errors.push({ code: "entry_hash_mismatch", id: row.id });
    if (index < sealed.length - 1 && row.previousHash !== sealed[index + 1].entryHash) errors.push({ code: "chain_link_mismatch", id: row.id });
    if (index > 0 && Number(sealed[index - 1].sequence || 0) !== Number(row.sequence || 0) + 1) errors.push({ code: "sequence_mismatch", id: row.id });
  }
  if (sealed.length && sealed.length < 5000 && sealed[sealed.length - 1].previousHash) errors.push({ code: "missing_predecessor", id: sealed[sealed.length - 1].id });
  if (head && (!sealed.length || head.entryHash !== sealed[0].entryHash || head.entryId !== sealed[0].id || Number(head.sequence || 0) !== Number(sealed[0].sequence || 0))) errors.push({ code: "head_mismatch", id: sealed[0]?.id || "" });
  return {
    ok: errors.length === 0,
    status: errors.length ? "compromised" : sealed.length ? "verified_with_legacy" : "legacy_unsealed",
    sealedCount: sealed.length,
    legacyCount,
    head: sealed[0] ? { entryId: sealed[0].id, entryHash: sealed[0].entryHash, sequence: sealed[0].sequence } : null,
    errors
  };
}

function asImportedLegacy(row) {
  const { _version, entryHash: ignoredHash, previousHash: ignoredPrevious, sequence: ignoredSequence, integrityVersion: ignoredVersion, ...value } = row;
  return { ...value, importedAuditIntegrity: ignoredHash ? "external_chain_not_trusted" : value.importedAuditIntegrity };
}

module.exports = { asImportedLegacy, createEntry, entryHash, verify };
