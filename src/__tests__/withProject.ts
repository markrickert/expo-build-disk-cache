import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Creates a temp project, writes `files` into it, runs the test, and cleans it up afterwards. */
export async function withProject(
	files: Record<string, string>,
	test: (projectRoot: string) => void | Promise<void>,
) {
	const projectRoot = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "expo-disk-cache-project-")),
	);
	try {
		for (const [file, content] of Object.entries(files)) {
			const filePath = path.join(projectRoot, file);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content);
		}
		await test(projectRoot);
	} finally {
		await fs.rm(projectRoot, { recursive: true, force: true });
	}
}
