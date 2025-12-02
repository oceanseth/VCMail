# Cleaning Up Old Terraform Resources

When you change the `project_name` variable in Terraform, new resources are created with the new name, but old resources are **not automatically deleted** because they're no longer in the Terraform state file.

## Why This Happens

Terraform only manages resources that are in its state file. When you change `project_name`:
- New resources are created: `${new_project_name}-api`, `${new_project_name}-email-processor-role`, etc.
- Old resources remain: `${old_project_name}-api`, `${old_project_name}-email-processor-role`, etc.
- Terraform doesn't know about the old resources, so it can't delete them

## Resources That Need Cleanup

The following resources use `project_name` and may need cleanup:

1. **Lambda Function**: `${project_name}-api`
2. **IAM Role**: `${project_name}-email-processor-role`
3. **IAM Policy** (inline): `${project_name}-email-processor-policy`
4. **API Gateway**: `${project_name}-api`
5. **CloudFront Origin Access Control**: `${project_name}-webmail-oac`
6. **SES Configuration Set**: `${project_name}-email-config`
7. **SES Rule Set**: `${project_name}-incoming-email`
8. **SES Receipt Rule**: `${project_name}-email-rule`
9. **Lambda Permissions**: Various permissions attached to the Lambda function

## Method 1: Automated Script (Recommended)

Use the cleanup script to identify old resources:

```bash
# In your project directory
npx vcmail cleanup-old-resources <old-project-name>

# Example:
npx vcmail cleanup-old-resources masky-mail
```

This will:
1. Search for all resources with the old project name
2. Display what was found
3. Generate delete commands for you to review and execute

## Method 2: Manual Cleanup via AWS CLI

### Step 1: Identify Resources

```bash
# List Lambda functions
aws lambda list-functions --query "Functions[?contains(FunctionName, 'old-project-name')].FunctionName"

# List IAM Roles
aws iam list-roles --query "Roles[?contains(RoleName, 'old-project-name')].RoleName"

# List API Gateways
aws apigateway get-rest-apis --query "items[?contains(name, 'old-project-name')].{Name:name,Id:id}"
```

### Step 2: Delete in Order

**Important**: Delete resources in this order to avoid dependency errors:

1. **Lambda Permissions** (if any external permissions exist)
2. **Lambda Functions**
   ```bash
   aws lambda delete-function --function-name old-project-name-api
   ```

3. **API Gateway Stages** (if any)
   ```bash
   aws apigateway delete-stage --rest-api-id <api-id> --stage-name prod
   ```

4. **API Gateway Deployments**
   ```bash
   aws apigateway delete-deployment --rest-api-id <api-id> --deployment-id <deployment-id>
   ```

5. **API Gateway**
   ```bash
   aws apigateway delete-rest-api --rest-api-id <api-id>
   ```
   ⚠️ **Warning**: Make sure no CloudFront distributions are using this API Gateway!

6. **IAM Policies** (inline policies)
   ```bash
   aws iam delete-role-policy --role-name old-project-name-email-processor-role --policy-name old-project-name-email-processor-policy
   ```

7. **IAM Roles**
   ```bash
   aws iam delete-role --role-name old-project-name-email-processor-role
   ```

8. **CloudFront Origin Access Controls** (if not in use)
   ```bash
   aws cloudfront delete-origin-access-control --id <oac-id>
   ```
   ⚠️ **Warning**: Make sure no CloudFront distributions are using this OAC!

9. **SES Configuration Sets**
   ```bash
   aws sesv2 delete-configuration-set --configuration-set-name old-project-name-email-config
   ```

10. **SES Rule Sets** (requires manual cleanup via AWS Console)
    - Go to AWS SES Console → Email Receiving → Rule Sets
    - Deactivate and delete the old rule set if not in use

## Method 3: Terraform State Import (Advanced)

If you still have access to the old Terraform state file, you can import the old resources and then destroy them:

```bash
# Import old Lambda function
terraform import aws_lambda_function.email_processor old-project-name-api

# Import old IAM role
terraform import aws_iam_role.lambda_email_processor old-project-name-email-processor-role

# Import old API Gateway
terraform import aws_api_gateway_rest_api.main <old-api-gateway-id>

# Then destroy
terraform destroy -target=aws_lambda_function.email_processor \
                  -target=aws_iam_role.lambda_email_processor \
                  -target=aws_api_gateway_rest_api.main
```

⚠️ **Warning**: This method requires careful handling of dependencies. Make sure you understand the resource relationships before destroying.

## Method 4: AWS Console (Safest for Verification)

1. Go to AWS Console
2. Navigate to each service (Lambda, IAM, API Gateway, etc.)
3. Search for resources with the old project name
4. Manually delete them, checking for dependencies

## Important Notes

1. **CloudFront Dependencies**: Before deleting API Gateways or OACs, check if any CloudFront distributions are using them. Update CloudFront first if needed.

2. **SES Dependencies**: SES Rule Sets may be active and receiving emails. Make sure you've migrated to the new rule set before deleting the old one.

3. **Cost**: Old Lambda functions and API Gateways may still incur costs. Clean them up to avoid unnecessary charges.

4. **Backup**: Consider backing up important configurations before deletion.

5. **Verification**: After cleanup, verify that your new resources are working correctly.

## Prevention

To avoid this issue in the future:

1. **Use consistent naming**: Choose a project name early and stick with it
2. **Use Terraform state management**: Consider using S3 backend for state files
3. **Document changes**: Keep track of when and why project names change
4. **Use tags**: All resources are tagged with `Project = var.project_name` for easier identification

## Troubleshooting

### "Cannot delete role: role is attached to policies"
- Delete inline policies first
- Detach managed policies if any

### "Cannot delete API Gateway: has active stages"
- Delete stages first
- Delete deployments before stages

### "Cannot delete Lambda: has active event source mappings"
- Delete event source mappings first
- Check for API Gateway integrations

### "Cannot delete OAC: in use by CloudFront distribution"
- Update CloudFront distribution to use new OAC
- Or delete CloudFront distribution if not needed



