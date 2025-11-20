#!/usr/bin/env node

/**
 * Helper script to find all dependencies needed by the Lambda function
 * Run this to see what packages need to be included in serverless.yml patterns
 */

const fs = require('fs');
const path = require('path');

function findDependencies(packageName, visited = new Set(), depth = 0) {
  if (visited.has(packageName) || depth > 10) {
    return [];
  }
  
  visited.add(packageName);
  const packagePath = path.join('node_modules', packageName, 'package.json');
  
  if (!fs.existsSync(packagePath)) {
    return [];
  }
  
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  const deps = [];
  
  // Add this package
  deps.push(packageName);
  
  // Add scoped packages
  if (packageName.startsWith('@')) {
    deps.push(`${packageName}/**`);
  }
  
  // Recursively find dependencies
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies
  };
  
  for (const dep of Object.keys(allDeps || {})) {
    const subDeps = findDependencies(dep, visited, depth + 1);
    deps.push(...subDeps);
  }
  
  return [...new Set(deps)]; // Remove duplicates
}

console.log('Finding dependencies for firebase-admin...\n');
const deps = findDependencies('firebase-admin');

console.log('Packages to include in serverless.yml patterns:');
console.log('===============================================\n');

// Group by scoped and unscoped
const scoped = deps.filter(d => d.startsWith('@'));
const unscoped = deps.filter(d => !d.startsWith('@') && !d.includes('/**'));

console.log('# Scoped packages:');
scoped.forEach(dep => {
  console.log(`- 'node_modules/${dep}/**'`);
});

console.log('\n# Unscoped packages:');
unscoped.forEach(dep => {
  console.log(`- 'node_modules/${dep}/**'`);
});

console.log('\n\nNote: This is a helper script. The template already includes common Firebase dependencies.');


