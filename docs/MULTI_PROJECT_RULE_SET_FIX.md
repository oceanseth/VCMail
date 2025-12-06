# Multi-Project Rule Set Detection Fix

## Problem

When running `npx vcmail` for multiple projects, each project could create its own SES rule set instead of detecting and reusing the active one. This caused:
- Multiple rule sets to exist
- Only one rule set can be active at a time
- Running setup for one project could deactivate another project's rule set
- Emails bouncing because the active rule set didn't have rules for all domains

## Solution

Improved the detection logic to **always** check for and use the active rule set if it exists, regardless of project name.

### Key Changes

1. **Enhanced Detection** (`lib/setup.js`):
   - `detectExistingRuleSet()` now returns detailed information:
     - `ruleSetName`: The active rule set name (if found)
     - `ruleExists`: Whether our rule already exists in that set
     - `existingRules`: List of existing rules for visibility
   - Always checks for active rule set first
   - Shows existing domains when reusing a rule set

2. **Always Use Active Rule Set**:
   - If an active rule set exists, **always** use it (even if it matches our project name)
   - Sets `sharedRuleSetName` and `activeRuleSetName` in config
   - Only creates new rule set if none exists

3. **Config Tracking**:
   - `activeRuleSetName` is saved to `vcmail.config.json`
   - Tracks which rule set we're actually using (may differ from project name)
   - Helps prevent confusion about which rule set is active

4. **Terraform Safety**:
   - When `sharedRuleSetName` is set, Terraform:
     - Does NOT create rule set (`count = 0`)
     - Does NOT activate rule set (`count = 0`)
     - Only creates/adds the receipt rule

## How It Works Now

### Scenario 1: First Project (masky-ai-mail)
1. Runs `npx vcmail`
2. No active rule set found
3. Creates `masky-ai-mail-incoming-email`
4. Activates it
5. Saves `activeRuleSetName: "masky-ai-mail-incoming-email"` to config

### Scenario 2: Second Project (voicecert-com-mail)
1. Runs `npx vcmail`
2. Detects active rule set: `masky-ai-mail-incoming-email`
3. Shows: "Found active VCMail rule set: masky-ai-mail-incoming-email"
4. Shows: "Existing domains in this rule set: masky.ai"
5. Sets `sharedRuleSetName: "masky-ai-mail-incoming-email"`
6. Sets `activeRuleSetName: "masky-ai-mail-incoming-email"`
7. Saves to config
8. Terraform adds rule to existing rule set (doesn't create/activate)

### Scenario 3: Re-running First Project
1. Runs `npx vcmail` again
2. Detects active rule set: `masky-ai-mail-incoming-email`
3. Matches project name → imports normally
4. Still saves `activeRuleSetName` to config for clarity
5. Terraform imports existing resources

## Benefits

✅ **No Duplicate Rule Sets**: Always reuses active rule set if it exists
✅ **No Deactivation**: Never deactivates existing rule sets
✅ **Clear Tracking**: Config file shows which rule set is actually being used
✅ **Visibility**: Shows existing domains when reusing rule set
✅ **Safety**: Terraform won't create/activate if using shared rule set

## Config File Fields

New field in `vcmail.config.json`:
- `activeRuleSetName`: The name of the SES rule set currently being used
  - May differ from `${projectName}-incoming-email` if using a shared rule set
  - Helps track which rule set is actually active

## Migration

If you have existing projects with separate rule sets:

1. **Check active rule set**:
   ```bash
   aws ses describe-active-receipt-rule-set
   ```

2. **Move rules to active set** (if needed):
   - Use AWS CLI to copy rules from inactive set to active set
   - Or run `npx vcmail` in each project - it will detect and use the active set

3. **Delete inactive rule sets** (after verifying all rules are in active set):
   ```bash
   aws ses delete-receipt-rule-set --rule-set-name <inactive-rule-set-name>
   ```

## Verification

After running `npx vcmail` in both projects:

```bash
# Check active rule set
aws ses describe-active-receipt-rule-set

# Should show both rules:
# - masky-ai-mail-email-rule (for masky.ai)
# - voicecert-com-mail-email-rule (for voicecert.com)
```

Both projects' config files should have:
```json
{
  "activeRuleSetName": "masky-ai-mail-incoming-email",
  "sharedRuleSetName": "masky-ai-mail-incoming-email"
}
```


