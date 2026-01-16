/**
 * Test script for decodeQuotedPrintable function
 * 
 * Usage: node test-decode-quoted-printable.js
 */

const { decodeQuotedPrintable } = require('./decodeQuotedPrintable');
const fs = require('fs');
const path = require('path');

// Load test cases from JSON file
const testFile = path.join(__dirname, 'test-decode-quoted-printable.json');
let testCases = [];

try {
    const testData = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    testCases = testData.testCases || [];
    console.log(`Loaded ${testCases.length} test cases from ${testFile}\n`);
} catch (error) {
    console.error(`Error loading test file: ${error.message}`);
    process.exit(1);
}

// Run tests
console.log('='.repeat(80));
console.log('Testing decodeQuotedPrintable function');
console.log('='.repeat(80));
console.log();

let passed = 0;
let failed = 0;
const failures = [];

for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    const { name, input, expected, description } = testCase;
    
    try {
        const result = decodeQuotedPrintable(input);
        const success = result === expected;
        
        if (success) {
            console.log(`✓ [${i + 1}/${testCases.length}] ${name}`);
            passed++;
        } else {
            console.log(`✗ [${i + 1}/${testCases.length}] ${name}`);
            console.log(`  Description: ${description || 'No description'}`);
            console.log(`  Input:       ${JSON.stringify(input)}`);
            console.log(`  Expected:    ${JSON.stringify(expected)}`);
            console.log(`  Got:         ${JSON.stringify(result)}`);
            
            // Show character codes for debugging
            if (expected && result) {
                const expectedCodes = Array.from(expected).map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
                const resultCodes = Array.from(result).map(c => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
                console.log(`  Expected codes: ${expectedCodes}`);
                console.log(`  Result codes:   ${resultCodes}`);
            }
            
            failed++;
            failures.push({ name, input, expected, result, description });
            console.log();
        }
    } catch (error) {
        console.log(`✗ [${i + 1}/${testCases.length}] ${name}`);
        console.log(`  ERROR: ${error.message}`);
        console.log(`  Stack: ${error.stack}`);
        failed++;
        failures.push({ name, input, expected, error: error.message });
        console.log();
    }
}

// Summary
console.log('='.repeat(80));
console.log('Test Summary');
console.log('='.repeat(80));
console.log(`Total tests:  ${testCases.length}`);
console.log(`Passed:       ${passed}`);
console.log(`Failed:       ${failed}`);
console.log(`Success rate: ${((passed / testCases.length) * 100).toFixed(1)}%`);
console.log();

if (failed > 0) {
    console.log('Failed tests:');
    failures.forEach((failure, index) => {
        console.log(`\n${index + 1}. ${failure.name}`);
        if (failure.error) {
            console.log(`   Error: ${failure.error}`);
        } else {
            console.log(`   Expected: ${JSON.stringify(failure.expected)}`);
            console.log(`   Got:      ${JSON.stringify(failure.result)}`);
        }
    });
    process.exit(1);
} else {
    console.log('All tests passed! ✓');
    process.exit(0);
}




