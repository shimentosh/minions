/** One encrypted page file: 25 MiB of plaintext plus the blob header and tag. */
export const PAGE_FILE_MAX_BYTES = 25 * 1024 * 1024 + 64;

/** Rich documents can be large; 2 MB of ciphertext is roughly 1.5 MB of JSON. */
export const PAGE_CONTENT_MAX = 2_000_000;

/** Pages per batch create (imports). The JSON body limit (3 MB) also applies. */
export const PAGE_BATCH_MAX = 200;
