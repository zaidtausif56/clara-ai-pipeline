// merge.js - Merges onboarding data into v1 memo to produce v2
// Preserves existing values, union-merges arrays, logs conflicts

const logger = require('./logger');

function mergeMemos(v1Memo, onboardingData) {
  const merged = JSON.parse(JSON.stringify(v1Memo)); // deep clone
  const conflicts = [];

  // Preserve account_id from v1
  merged.account_id = v1Memo.account_id;

  const stringFields = [
    'company_name',
    'office_address',
    'after_hours_flow_summary',
    'office_hours_flow_summary',
    'notes',
  ];

  for (const field of stringFields) {
    const oldVal = v1Memo[field];
    const newVal = onboardingData[field];

    if (newVal != null && newVal !== '' && newVal !== oldVal) {
      if (oldVal != null && oldVal !== '') {
        // both have values - prefer onboarding (more precise)
        conflicts.push({
          field,
          old_value: oldVal,
          new_value: newVal,
          resolution: 'Updated to onboarding value (operational precision takes precedence)',
        });
      }
      merged[field] = newVal;
    }
  }

  if (onboardingData.business_hours && typeof onboardingData.business_hours === 'object') {
    if (!merged.business_hours) {
      merged.business_hours = { days: null, start: null, end: null, timezone: null };
    }
    for (const sub of ['days', 'start', 'end', 'timezone']) {
      const oldVal = merged.business_hours[sub];
      const newVal = onboardingData.business_hours[sub];

      if (newVal != null && newVal !== '' && newVal !== oldVal) {
        if (oldVal != null && oldVal !== '') {
          conflicts.push({
            field: `business_hours.${sub}`,
            old_value: oldVal,
            new_value: newVal,
            resolution: 'Updated to onboarding value',
          });
        }
        merged.business_hours[sub] = newVal;
      }
    }
  }

  const arrayFields = [
    'services_supported',
    'emergency_definition',
    'emergency_routing_rules',
    'non_emergency_routing_rules',
    'call_transfer_rules',
    'integration_constraints',
  ];

  for (const field of arrayFields) {
    const oldArr = Array.isArray(v1Memo[field]) ? v1Memo[field] : [];
    const newArr = Array.isArray(onboardingData[field]) ? onboardingData[field] : [];

    if (newArr.length > 0) {
      const combined = [...new Set([...oldArr, ...newArr])];

      if (oldArr.length > 0 && !arraysEqual(oldArr, combined)) {
        conflicts.push({
          field,
          old_value: oldArr,
          new_value: combined,
          resolution: 'Merged (union of v1 and onboarding values)',
        });
      }

      merged[field] = combined;
    }
  }

  // re-evaluate gaps after merge
  merged.questions_or_unknowns = reEvaluateUnknowns(merged);

  if (conflicts.length > 0) {
    logger.info(`Merge completed with ${conflicts.length} conflict(s)`, {
      account_id: merged.account_id,
    });
  } else {
    logger.info('Merge completed (no conflicts)', { account_id: merged.account_id });
  }

  return { merged, conflicts };
}

function reEvaluateUnknowns(memo) {
  const unknowns = [];

  const bh = memo.business_hours || {};
  if (!bh.days && !bh.start && !bh.end && !bh.timezone) {
    unknowns.push('Business hours not specified');
  }
  if (!memo.emergency_definition || memo.emergency_definition.length === 0) {
    unknowns.push('Emergency definition not provided');
  }
  if (!memo.emergency_routing_rules || memo.emergency_routing_rules.length === 0) {
    unknowns.push('Emergency routing rules not specified');
  }
  if (!memo.services_supported || memo.services_supported.length === 0) {
    unknowns.push('Services supported not listed');
  }
  if (!memo.non_emergency_routing_rules || memo.non_emergency_routing_rules.length === 0) {
    unknowns.push('Non-emergency routing rules not specified');
  }
  if (!memo.call_transfer_rules || memo.call_transfer_rules.length === 0) {
    unknowns.push('Call transfer rules not specified');
  }

  return unknowns;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

module.exports = {
  mergeMemos,
};

// CLI: node scripts/merge.js <v1_memo.json> <onboarding_memo.json>
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const v1Path = process.argv[2];
  const obPath = process.argv[3];

  if (!v1Path || !obPath) {
    console.error('Usage: node scripts/merge.js <v1_memo.json> <onboarding_memo.json>');
    process.exit(1);
  }

  const v1 = JSON.parse(fs.readFileSync(path.resolve(v1Path), 'utf-8'));
  const ob = JSON.parse(fs.readFileSync(path.resolve(obPath), 'utf-8'));

  const { merged, conflicts } = mergeMemos(v1, ob);

  console.log('=== MERGED MEMO ===');
  console.log(JSON.stringify(merged, null, 2));

  if (conflicts.length > 0) {
    console.log('\n=== CONFLICTS ===');
    console.log(JSON.stringify(conflicts, null, 2));
  }
}
