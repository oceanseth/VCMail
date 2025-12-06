/**
 * Diagnose API Gateway and CloudFront integration issues
 * Checks if API Gateway stage is using latest deployment
 */

const { execSync } = require('child_process');

function runCommand(command) {
  try {
    return JSON.parse(execSync(command, { encoding: 'utf-8', stdio: 'pipe' }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return null;
  }
}

function diagnoseAPIGateway(apiGatewayId, stageName = 'prod') {
  console.log(`\n🔍 Diagnosing API Gateway: ${apiGatewayId} (stage: ${stageName})\n`);
  
  // Get stage info
  const stage = runCommand(
    `aws apigateway get-stage --rest-api-id ${apiGatewayId} --stage-name ${stageName} --output json`
  );
  
  if (!stage) {
    console.error('❌ Failed to get stage information');
    return false;
  }
  
  console.log(`📋 Stage Information:`);
  console.log(`   Deployment ID: ${stage.deploymentId}`);
  console.log(`   Last Updated: ${stage.lastUpdatedDate}`);
  
  // Get all deployments
  const deployments = runCommand(
    `aws apigateway get-deployments --rest-api-id ${apiGatewayId} --output json`
  );
  
  if (!deployments || !deployments.items) {
    console.error('❌ Failed to get deployments');
    return false;
  }
  
  console.log(`\n📋 Deployments:`);
  deployments.items.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
  deployments.items.forEach((deployment, index) => {
    const isActive = deployment.id === stage.deploymentId;
    const marker = isActive ? '👉' : '  ';
    console.log(`${marker} ${deployment.id}: ${deployment.createdDate} ${isActive ? '(ACTIVE)' : ''}`);
  });
  
  const latestDeployment = deployments.items[0];
  const isUsingLatest = stage.deploymentId === latestDeployment.id;
  
  if (!isUsingLatest) {
    console.error(`\n❌ Stage is NOT using latest deployment!`);
    console.error(`   Current: ${stage.deploymentId} (${deployments.items.find(d => d.id === stage.deploymentId).createdDate})`);
    console.error(`   Latest:  ${latestDeployment.id} (${latestDeployment.createdDate})`);
    console.error(`\n   This is likely causing the 500 errors!`);
    console.error(`\n   Solution: Run 'terraform apply' to update the stage, or manually update:`);
    console.error(`   aws apigateway update-stage --rest-api-id ${apiGatewayId} --stage-name ${stageName} --patch-op op=replace,path=/deploymentId,value=${latestDeployment.id}`);
    return false;
  }
  
  console.log(`\n✅ Stage is using latest deployment`);
  
  // Test API Gateway
  console.log(`\n🧪 Testing API Gateway...`);
  const testUrl = `https://${apiGatewayId}.execute-api.us-east-1.amazonaws.com/${stageName}/api/test`;
  console.log(`   URL: ${testUrl}`);
  
  try {
    const response = execSync(
      `curl -s -X POST "${testUrl}" -H "Content-Type: application/json"`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 }
    );
    const result = JSON.parse(response);
    if (result.status === 'ok') {
      console.log(`✅ API Gateway test endpoint works!`);
      return true;
    } else {
      console.error(`❌ API Gateway returned unexpected response:`, result);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to test API Gateway: ${error.message}`);
    if (error.stdout) {
      console.error(`   Response: ${error.stdout}`);
    }
    return false;
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node diagnose-api-gateway.js <api-gateway-id> [stage-name]');
    console.error('Example: node diagnose-api-gateway.js vgv1rnzmhi prod');
    process.exit(1);
  }
  
  const apiGatewayId = args[0];
  const stageName = args[1] || 'prod';
  
  const success = diagnoseAPIGateway(apiGatewayId, stageName);
  process.exit(success ? 0 : 1);
}

module.exports = { diagnoseAPIGateway };


