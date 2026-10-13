import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

// Solo el emulador usa este puerto. Carpeta persistente fuera de cualquier
// express.static; directorio 0700 y archivos 0600. Nunca entrega una URL.
export function createLocalReceiptStorage(directory) {
  const path = asset => {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|gif|pdf)$/u.test(asset.publicId)) throw new Error("Archivo privado local inválido");
    return join(directory, asset.publicId);
  };
  return {
    descriptor: (id, extension) => ({ publicId: id + "." + extension, resourceType: "raw", deliveryType: "authenticated", format: extension }),
    async put(asset, file, { signal } = {}) {
      signal?.throwIfAborted(); await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = path(asset) + "." + randomUUID() + ".tmp";
      try { await writeFile(temporary, file.data, { mode: 0o600, flag: "wx", signal });
        signal?.throwIfAborted(); await rename(temporary, path(asset)); }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    },
    read: asset => readFile(path(asset)),
    async delete(asset) { try { await unlink(path(asset)); } catch (error) { if (error.code !== "ENOENT") throw error; } },
  };
}
