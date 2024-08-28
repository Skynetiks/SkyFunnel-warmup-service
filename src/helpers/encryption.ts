import crypto from 'crypto';

/**
 * Encrypts a given text using AES-256-CBC.
 * 
 * @param {string} text - The text to be encrypted (e.g., access token).
 * @param {string} secretKey - A 32-byte hexadecimal string used for encryption.
 * @returns {string} The encrypted text combined with the IV, separated by a colon.
 */
export function encryptToken(text:string, secretKey:string):string {
    const iv = crypto.randomBytes(16); // Generate a random initialization vector (IV)
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secretKey, 'hex'), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`; // Combine IV and encrypted token
}

/**
 * Decrypts a given encrypted text using AES-256-CBC.
 * 
 * @param {string} encryptedText - The encrypted text (e.g., encrypted token).
 * @param {string} secretKey - A 32-byte hexadecimal string used for decryption.
 * @returns {string} The decrypted text (e.g., access token).
 */
export function decryptToken(encryptedText:string, secretKey:string):string {
    const [ivHex, encryptedHex] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedTextBuffer = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(secretKey, 'hex'), iv);
    let decrypted = decipher.update(encryptedTextBuffer);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}
