# Multi-Project Setup Guide

VCMail now supports running multiple projects (with different domains) in the same AWS account without conflicts. This guide explains how it works and what you need to know.

## Overview

When you run VCMail setup for multiple projects in the same AWS account, the system automatically detects and reuses existing SES rule sets. This prevents conflicts and ensures all projects can process emails simultaneously.

## How It Works

### Automatic Detection

When you run `npx vcmail` for a new project:

1. **Detection Phase**: The setup script checks if there's an active SES receipt rule set that ends with `-incoming-email` (VCMail's naming convention).

2. **Rule Set Reuse**: If a VCMail-managed rule set is found:
   - The new project will add its rule to the existing rule set
   - No new rule set will be created
   - The existing rule set remains active

3. **Rule Creation**: Each project creates its own rule with a unique name: `${project_name}-email-rule`
   - Each rule matches emails for its specific domain only
   - Each rule routes emails to its own Lambda function

4. **Lambda Independence**: Each project has its own Lambda function:
   - Lambda's `VCMAIL_CONFIG.domain` is set to that project's domain only
   - Lambda only processes emails for its configured domain
   - If an email for another domain somehow reaches this Lambda, it logs an info message and returns success (doesn't process it)
   - **Projects don't need to know about each other** - each Lambda is completely independent

### Example Scenario

**Project A** (domain: `example.com`, project_name: `example-mail`):
- Creates rule set: `example-mail-incoming-email`
- Creates rule: `example-mail-email-rule` matching `example.com`
- Activates the rule set

**Project B** (domain: `another.com`, project_name: `another-mail`):
- Detects existing rule set: `example-mail-incoming-email`
- Adds rule: `another-mail-email-rule` matching `another.com`
- Does NOT create or activate a new rule set

Both projects now share the same rule set, but each has its own rule for its domain.

## Requirements

### ✅ What Works

- **Different domains**: Each project must use a unique domain
- **Unique project names**: Each project must have a unique `project_name` (ensures unique rule names)
- **Same AWS account**: All projects must be in the same AWS account
- **Same AWS region**: All projects should use the same AWS region for SES

### ⚠️ Important Notes

1. **Rule Set Ownership**: The first project to run creates and "owns" the rule set. Other projects add rules to it but don't manage it.

2. **Rule Set Deletion**: If the first project tries to destroy its infrastructure, it cannot delete the shared rule set while other projects' rules exist in it. This is a safety feature.

3. **Rule Name Conflicts**: Ensure each project has a unique `project_name` to avoid rule name conflicts.

4. **Domain Conflicts**: Each project must use a different domain. If two projects use the same domain, DNS records and SES identities will conflict.

## Configuration

The setup process automatically handles multi-project detection. No manual configuration is required. However, if you need to manually set the shared rule set name, you can add it to your `vcmail.config.json`:

```json
{
  "domain": "example.com",
  "projectName": "example-mail",
  "sharedRuleSetName": "existing-project-incoming-email"
}
```

Or in `terraform.tfvars`:

```hcl
shared_rule_set_name = "existing-project-incoming-email"
```

## Troubleshooting

### Issue: "Rule already exists"

If you see this error, it means a rule with the same name already exists in the rule set. This can happen if:
- You're re-running setup for the same project
- Another project is using the same `project_name`

**Solution**: Use a unique `project_name` for each project.

### Issue: "Cannot delete rule set"

If you try to destroy a project that created the shared rule set, Terraform may fail because other projects' rules exist in it.

**Solution**: 
1. First, destroy all other projects that use the shared rule set
2. Then destroy the project that created the rule set
3. Or manually delete the rule set via AWS Console after removing all rules

### Issue: "Active rule set not found"

If you see this, it means no active rule set exists. The first project will create one.

**Solution**: This is normal for the first project. No action needed.

## Technical Details

### Terraform Resources

- **Rule Set**: Created only if `shared_rule_set_name` is not set (`count = 0` if shared)
- **Active Rule Set**: Activated only if we created the rule set (`count = 0` if shared)
- **Receipt Rule**: Always created (no count condition) - adds to shared or new rule set

### Resource Naming

- Rule Set: `${project_name}-incoming-email` (or shared name)
- Rule: `${project_name}-email-rule`
- Lambda: `${project_name}-api`
- IAM Role: `${project_name}-email-processor-role`

All other resources use `project_name` for uniqueness.

## Best Practices

1. **Use descriptive project names**: Include the domain in the project name (e.g., `example-mail`, `another-mail`)

2. **Document your projects**: Keep track of which project created the shared rule set

3. **Test in isolation first**: Set up your first project and verify it works before adding more

4. **Use consistent naming**: Follow a naming convention for `project_name` across all projects

5. **Monitor AWS costs**: Multiple projects share infrastructure but each creates its own Lambda, API Gateway, etc.

## Migration from Single Project

If you already have a VCMail project running and want to add another:

1. **No changes needed**: Just run `npx vcmail` in your new project directory
2. **Automatic detection**: The setup will detect your existing rule set
3. **Seamless integration**: The new project will add its rule to the existing rule set

No migration steps are required - the system handles it automatically!

