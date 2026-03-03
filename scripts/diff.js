// diff.js - Generates field-level changelog between v1 and v2 memos

const logger = require('./logger');

function generateChangelog(v1Memo, v2Memo, conflicts = []) {
  const changes = {};

  const stringFields = [
    'company_name',
    'office_address',
    'after_hours_flow_summary',
    'office_hours_flow_summary',
    'notes',
  ];

  for (const field of stringFields) {
    const oldVal = v1Memo[field] ?? null;
    const newVal = v2Memo[field] ?? null;
    if (oldVal !== newVal) {
      changes[field] = { old: oldVal, new: newVal };
    }
  }

  const oldBH = v1Memo.business_hours || {};
  const newBH = v2Memo.business_hours || {};
  for (const sub of ['days', 'start', 'end', 'timezone']) {
    const oldVal = oldBH[sub] ?? null;
    const newVal = newBH[sub] ?? null;
    if (oldVal !== newVal) {
      changes[`business_hours.${sub}`] = { old: oldVal, new: newVal };
    }
  }

  const arrayFields = [
    'services_supported',
    'emergency_definition',
    'emergency_routing_rules',
    'non_emergency_routing_rules',
    'call_transfer_rules',
    'integration_constraints',
    'questions_or_unknowns',
  ];

  for (const field of arrayFields) {
    const oldArr = v1Memo[field] || [];
    const newArr = v2Memo[field] || [];
    if (!arraysEqual(oldArr, newArr)) {
      changes[field] = {
        old: oldArr,
        new: newArr,
        added: newArr.filter((v) => !oldArr.includes(v)),
        removed: oldArr.filter((v) => !newArr.includes(v)),
      };
    }
  }

  const changelog = {
    account_id: v2Memo.account_id || v1Memo.account_id,
    from_version: 'v1',
    to_version: 'v2',
    timestamp: new Date().toISOString(),
    total_fields_changed: Object.keys(changes).length,
    changes,
  };

  if (conflicts && conflicts.length > 0) {
    changelog.conflicts = conflicts;
  }

  logger.info('Changelog generated', {
    account_id: changelog.account_id,
    fields_changed: changelog.total_fields_changed,
  });

  return changelog;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

module.exports = {
  generateChangelog,
};

// CLI: node scripts/diff.js <v1_memo.json> <v2_memo.json>
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const v1Path = process.argv[2];
  const v2Path = process.argv[3];

  if (!v1Path || !v2Path) {
    console.error('Usage: node scripts/diff.js <v1_memo.json> <v2_memo.json>');
    process.exit(1);
  }

  const v1 = JSON.parse(fs.readFileSync(path.resolve(v1Path), 'utf-8'));
  const v2 = JSON.parse(fs.readFileSync(path.resolve(v2Path), 'utf-8'));

  const changelog = generateChangelog(v1, v2);
  console.log(JSON.stringify(changelog, null, 2));
}
