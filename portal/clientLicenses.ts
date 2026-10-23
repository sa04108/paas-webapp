import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

// 실제 번들 의존성에 포함된 라이선스 원문을 배포 결과물에 보존한다.
export function clientLicenses(): Plugin {
  return {
    name: "client-license-notices",
    generateBundle() {
      const roots = [
        "react",
        "react-dom",
        "react-router-dom",
        "@xterm/xterm",
        "@xterm/addon-fit",
      ];
      const pending = roots.map((name) => ({ name, from: __dirname }));
      const visited = new Set<string>();
      const notices: string[] = [];
      while (pending.length) {
        const { name, from } = pending.pop()!;
        const requireFrom = createRequire(path.join(from, "package.json"));
        let directory: string;
        try {
          directory = path.dirname(requireFrom.resolve(`${name}/package.json`));
        } catch {
          directory = path.dirname(requireFrom.resolve(name));
          while (!fs.existsSync(path.join(directory, "package.json"))) {
            const parent = path.dirname(directory);
            if (parent === directory)
              throw new Error(`Cannot locate license for ${name}`);
            directory = parent;
          }
        }
        if (visited.has(directory)) continue;
        visited.add(directory);
        const metadata = JSON.parse(
          fs.readFileSync(path.join(directory, "package.json"), "utf8"),
        );
        const license = fs
          .readdirSync(directory)
          .find((file) => /^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
        if (!license) throw new Error(`Missing license notice for ${name}`);
        notices.push(
          `${metadata.name}@${metadata.version}\n${"=".repeat(60)}\n${fs.readFileSync(path.join(directory, license), "utf8")}`,
        );
        for (const dependency of Object.keys(metadata.dependencies || {}))
          pending.push({ name: dependency, from: directory });
      }
      this.emitFile({
        type: "asset",
        fileName: "third-party-notices.txt",
        source: `Open source licenses for the portal browser bundle\n\n${notices.sort().join("\n\n")}\n`,
      });
    },
  };
}
