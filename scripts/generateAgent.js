// generateAgent.js - Builds Retell Agent spec (system prompt + config) from account memo

const logger = require('./logger');

// Build the system prompt with business-hours and after-hours call flows
function buildSystemPrompt(memo) {
  const companyName = memo.company_name || 'the company';
  const bh = memo.business_hours || {};
  const hoursStr = formatBusinessHours(bh);
  const servicesStr = (memo.services_supported || []).join(', ') || 'general services';
  const emergencyDef = (memo.emergency_definition || []).join('; ') || 'not yet defined';
  const emergencyRouting = (memo.emergency_routing_rules || []).join('; ') || 'attempt transfer to on-call personnel';
  const nonEmergencyRouting = (memo.non_emergency_routing_rules || []).join('; ') || 'collect details and confirm follow-up during business hours';
  const transferRules = (memo.call_transfer_rules || []).join('; ') || 'attempt transfer, retry once, then take a message';
  const integrationNotes = (memo.integration_constraints || []).join('; ');
  const afterHoursFlow = memo.after_hours_flow_summary || '';
  const officeHoursFlow = memo.office_hours_flow_summary || '';
  const address = memo.office_address || 'not on file';

  const prompt = `You are Clara, a professional AI answering service agent for ${companyName}.

COMPANY INFORMATION:
- Company: ${companyName}
- Address: ${address}
- Services: ${servicesStr}
- Business Hours: ${hoursStr}

EMERGENCY DEFINITIONS:
${emergencyDef}

---

BUSINESS HOURS CALL FLOW:
When a call comes in during business hours (${hoursStr}):

1. GREETING: "Thank you for calling ${companyName}. This is Clara, how may I help you today?"

2. ASK PURPOSE: Listen to the caller's reason for calling.

3. COLLECT INFORMATION:
   - Ask for the caller's full name.
   - Ask for a callback phone number.
   - Collect only the information needed for proper routing. Do not ask excessive questions.

4. ROUTE OR TRANSFER:
   ${officeHoursFlow ? `Office hours routing: ${officeHoursFlow}` : `Attempt to transfer the call to the appropriate department or person.`}
   Transfer rules: ${transferRules}

5. FALLBACK IF TRANSFER FAILS:
   - If the transfer cannot be completed, apologize and let the caller know their message will be delivered promptly.
   - Say: "I apologize, I'm unable to connect you right now. I'll make sure your message is delivered and someone will get back to you shortly."

6. WRAP UP:
   - Ask: "Is there anything else I can help you with?"
   - If no: "Thank you for calling ${companyName}. Have a great day!"

---

AFTER HOURS CALL FLOW:
When a call comes in outside business hours:

1. GREETING: "Thank you for calling ${companyName}. You've reached us outside of our regular business hours. This is Clara, how may I help you?"

2. ASK PURPOSE: Listen to the caller's reason for calling.

3. DETERMINE EMERGENCY:
   - Ask: "Is this an emergency situation?"
   - Emergency is defined as: ${emergencyDef}

4. IF EMERGENCY:
   a. Immediately collect:
      - Caller's full name
      - Callback phone number
      - Service address or location of the emergency
   b. Attempt transfer: ${emergencyRouting}
   c. If transfer fails:
      - Say: "I apologize, I'm unable to reach the on-call team right now. I have your information and will make sure someone contacts you as quickly as possible."
      - Assure the caller that their emergency will be addressed promptly.

5. IF NOT EMERGENCY:
   ${nonEmergencyRouting}
   - Collect the caller's name, phone number, and a brief description of what they need.
   - Confirm: "I'll make sure this message is delivered first thing during our next business day. Someone will follow up with you."

6. WRAP UP:
   - Ask: "Is there anything else I can help you with?"
   - If no: "Thank you for calling ${companyName}. Have a good evening!"

---

IMPORTANT RULES:
- Be professional, warm, and concise.
- Never mention internal tools, function calls, APIs, or technical systems to the caller.
- Only collect information that is necessary for routing and dispatch.
- Do not make promises about specific response times unless instructed.
- If you are unsure about something, take a message rather than guessing.
${integrationNotes ? `\nINTEGRATION CONSTRAINTS:\n${integrationNotes}` : ''}
${afterHoursFlow ? `\nADDITIONAL AFTER-HOURS NOTES:\n${afterHoursFlow}` : ''}`;

  return prompt;
}

function formatBusinessHours(bh) {
  if (!bh) return 'Not specified';
  const parts = [];
  if (bh.days) parts.push(bh.days);
  if (bh.start && bh.end) parts.push(`${bh.start} - ${bh.end}`);
  else if (bh.start) parts.push(`from ${bh.start}`);
  if (bh.timezone) parts.push(bh.timezone);
  return parts.length > 0 ? parts.join(', ') : 'Not specified';
}

function generateAgentSpec(memo, version = 'v1') {
  const companyName = memo.company_name || 'Unknown Company';

  const spec = {
    agent_name: `Clara - ${companyName}`,
    version,
    voice_style: 'professional, warm, concise',
    system_prompt: buildSystemPrompt(memo),
    variables: {
      company_name: companyName,
      timezone: memo.business_hours?.timezone || null,
      business_hours: memo.business_hours || null,
      office_address: memo.office_address || null,
      services: memo.services_supported || [],
      emergency_definitions: memo.emergency_definition || [],
      emergency_routing: memo.emergency_routing_rules || [],
    },
    tool_invocation_placeholders: [
      {
        name: 'transfer_call',
        description: 'Transfer the call to the specified phone number or extension',
        trigger: 'When routing rules indicate a transfer is needed',
      },
      {
        name: 'create_ticket',
        description: 'Create a service ticket or message for follow-up',
        trigger: 'When a message needs to be taken for callback',
      },
      {
        name: 'lookup_on_call',
        description: 'Look up the current on-call personnel',
        trigger: 'When an emergency call needs to be routed after hours',
      },
    ],
    call_transfer_protocol: {
      method: 'Transfer call to designated number/extension',
      rules: memo.call_transfer_rules || [],
      timeout_action: 'Take message and assure follow-up',
    },
    fallback_protocol: {
      transfer_fail: 'Apologize, confirm details collected, assure prompt follow-up',
      system_error: 'Take a message with name and phone number, promise callback',
    },
  };

  logger.info('Agent spec generated', { agent_name: spec.agent_name, version });
  return spec;
}

module.exports = {
  generateAgentSpec,
  buildSystemPrompt,
};

// CLI: node scripts/generateAgent.js <memo.json> [v1|v2]
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  const memoPath = process.argv[2];
  const version = process.argv[3] || 'v1';

  if (!memoPath) {
    console.error('Usage: node scripts/generateAgent.js <memo.json> [v1|v2]');
    process.exit(1);
  }

  const fullPath = path.resolve(memoPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const memo = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  const spec = generateAgentSpec(memo, version);
  console.log(JSON.stringify(spec, null, 2));
}
