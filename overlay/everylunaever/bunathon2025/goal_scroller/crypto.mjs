/**
 * Converts an array buffer to a base64
 * @param {ArrayBuffer} buffer
 */
export function arrayBufferToBase64Url(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\//g, '_').replace(/\+/g, '-');
}

/**
 * Converts a base64 to an array buffer
 * @param {string} base64
 */
export function base64UrlToArrayBuffer(base64) {
    const binary = atob(base64.replace(/_/g, '/').replace(/-/g, '+'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// Generate a fresh symmetric key
export async function generateKey() {
    return crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

/**
 * Exports a CryptoKey as a base64
 * @param {CryptoKey} key
 */
export async function exportKey(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return arrayBufferToBase64Url(raw);
}

/**
 * Imports a base64 key as a CryptoKey
 * @param {string} base64
 */
export async function importKey(base64) {
    const raw = base64UrlToArrayBuffer(base64);
    return crypto.subtle.importKey(
        "raw",
        raw,
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypt
 * @param {string | undefined} text
 * @param {CryptoKey} key
 */
export async function encrypt(text, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded
    );

    return {
        iv: arrayBufferToBase64Url(iv.buffer),
        data: arrayBufferToBase64Url(ciphertext),
    };
}

/**
 * Decrypt
 * @param {{ iv: any; data: any; }} encrypted
 * @param {CryptoKey} key
 */
export async function decrypt(encrypted, key) {
    const iv = base64UrlToArrayBuffer(encrypted.iv);
    const data = base64UrlToArrayBuffer(encrypted.data);
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        key,
        data
    );
    return new TextDecoder().decode(decrypted);
}

/**
 * Generates a fresh symmetric key and encrypts the given text as a json string
 * @param {string} originalText 
 */
export async function initialize(originalText) {
    const key = await generateKey();
    const encrypted = await encrypt(originalText, key);

    //console.log("Original:", originalText);
    //console.log("Verschlüsselt (Base64Url):", JSON.stringify(encrypted, undefined, 4));
    //console.log("Entschlüsselt:", decrypted);

    const exportedKey = await exportKey(key);
    //console.log("Exportierter Schlüssel (Base64Url):", exportedKey);

    //const importedKey = await importKey(exportedKey);
    //const decryptedAgain = await decrypt(encrypted, importedKey);
    //console.log("Entschlüsselt mit importiertem Schlüssel:", decryptedAgain);

    return {
        key: JSON.stringify(encrypted, undefined, 4),
        encrypted: JSON.stringify(encrypted, undefined, 4),
    }
}
