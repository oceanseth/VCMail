/**
 * Decode quoted-printable encoded strings with proper UTF-8 support
 * 
 * This function handles:
 * - Soft line breaks (=CRLF, =LF, =CR)
 * - Hex-encoded bytes (=XX)
 * - UTF-8 multi-byte characters
 * - Mixed content (both encoded and plain text)
 */

function decodeQuotedPrintable(str) {
    if (!str) return str;
    
    // Remove soft line breaks first (=\r\n, =\n, =\r)
    // These are line continuation markers in quoted-printable
    let cleaned = str.replace(/=\r?\n/g, '');
    
    // Build a buffer to hold the decoded bytes
    // We allocate enough space for worst case (all characters are single bytes)
    const buffer = Buffer.alloc(cleaned.length);
    let bufferIndex = 0;
    let i = 0;
    
    while (i < cleaned.length) {
        // Check for quoted-printable hex sequence (=XX)
        if (cleaned[i] === '=' && i + 2 < cleaned.length) {
            const hex = cleaned.substring(i + 1, i + 3);
            // Validate hex sequence
            if (/^[A-Fa-f0-9]{2}$/.test(hex)) {
                try {
                    // Parse hex byte and add to buffer
                    const byte = parseInt(hex, 16);
                    buffer[bufferIndex++] = byte;
                    i += 3; // Skip the =XX sequence
                    continue;
                } catch (e) {
                    console.warn('Failed to decode hex sequence:', hex, e);
                    // Fall through to handle as regular character
                }
            }
        }
        
        // Handle regular character
        // For UTF-8 characters, we need to get the bytes properly
        // Use Buffer.from() to convert the character to UTF-8 bytes
        const char = cleaned[i];
        const charBytes = Buffer.from(char, 'utf8');
        
        // Copy bytes to our buffer
        for (let j = 0; j < charBytes.length; j++) {
            if (bufferIndex < buffer.length) {
                buffer[bufferIndex++] = charBytes[j];
            }
        }
        
        i++;
    }
    
    // Convert buffer to UTF-8 string
    // Only use the portion of the buffer we actually filled
    try {
        const decoded = buffer.slice(0, bufferIndex).toString('utf8');
        return decoded;
    } catch (e) {
        console.warn('Failed to convert buffer to UTF-8:', e);
        // Fallback: try to decode with error handling
        try {
            // Use 'latin1' encoding which maps 1:1 with bytes, then convert
            const latin1String = buffer.slice(0, bufferIndex).toString('latin1');
            // Try to convert to UTF-8
            return Buffer.from(latin1String, 'latin1').toString('utf8');
        } catch (e2) {
            console.error('Fallback decoding also failed:', e2);
            // Last resort: return original string with soft breaks removed
            return cleaned;
        }
    }
}

/**
 * Test function to verify decoding works correctly
 */
function testDecodeQuotedPrintable() {
    const testCases = [
        {
            name: 'Copyright symbol',
            input: '=C2=A9 2025 Twitch',
            expected: '© 2025 Twitch'
        },
        {
            name: 'Simple text',
            input: 'Hello World',
            expected: 'Hello World'
        },
        {
            name: 'Mixed content',
            input: 'Hello =C2=A9 World',
            expected: 'Hello © World'
        },
        {
            name: 'Soft line break',
            input: 'Line 1=\r\nLine 2',
            expected: 'Line 1Line 2'
        },
        {
            name: 'Multiple UTF-8 characters',
            input: '=C2=A9 =C2=AE =E2=84=A2',
            expected: '© ® ™'
        },
        {
            name: 'Email with special chars',
            input: 'Test =E2=80=93 dash',
            expected: 'Test – dash'
        }
    ];
    
    console.log('Testing decodeQuotedPrintable function:\n');
    
    let passed = 0;
    let failed = 0;
    
    for (const testCase of testCases) {
        const result = decodeQuotedPrintable(testCase.input);
        const success = result === testCase.expected;
        
        if (success) {
            console.log(`✓ ${testCase.name}`);
            passed++;
        } else {
            console.log(`✗ ${testCase.name}`);
            console.log(`  Input:    ${JSON.stringify(testCase.input)}`);
            console.log(`  Expected: ${JSON.stringify(testCase.expected)}`);
            console.log(`  Got:      ${JSON.stringify(result)}`);
            failed++;
        }
    }
    
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    return failed === 0;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decodeQuotedPrintable, testDecodeQuotedPrintable };
}

// Run tests if executed directly
if (require.main === module) {
    testDecodeQuotedPrintable();
}

