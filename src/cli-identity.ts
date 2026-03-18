import type { Command } from "commander";
import fs from "fs";
import path from "path";
import { die } from "./cli-shared.js";
import { c } from "./render.js";

export function registerIdentityCommands(program: Command): void {
  const identity = program.command("identity").description("Manage agent identities");

  identity
    .command("list")
    .description("List available identities")
    .action(async () => {
      const identitiesDir = path.join(process.cwd(), "identities");
      if (!fs.existsSync(identitiesDir)) {
        console.log("No identities/ folder found.");
        return;
      }
      const files = fs.readdirSync(identitiesDir).filter((f) => f.endsWith(".md"));
      if (files.length === 0) {
        console.log("No identity files found in identities/");
        return;
      }
      console.log("Available identities:");
      for (const file of files) {
        console.log(`  ${file.replace(/\.md$/, "")}`);
      }
    });

  identity
    .command("show <name>")
    .description("Show an identity file")
    .action(async (name: string) => {
      const identityPath = path.join(process.cwd(), "identities", `${name}.md`);
      if (!fs.existsSync(identityPath)) {
        die(`Identity not found: ${name}`);
      }
      console.log(fs.readFileSync(identityPath, "utf-8"));
    });

  identity
    .command("import <pathOrGlob>")
    .description("Import agency-agents format identities from markdown files")
    .action(async (pathOrGlob: string) => {
      const { parseIdentityFrontmatter, listIdentities, saveIdentity } = await import("./identities.js");

      let files: string[];
      try {
        const resolved = path.resolve(pathOrGlob);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          files = [resolved];
        } else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          files = fs.readdirSync(resolved)
            .filter(f => f.endsWith(".md"))
            .map(f => path.join(resolved, f));
        } else {
          files = fs.globSync(pathOrGlob) as unknown as string[];
        }
      } catch {
        die(`Failed to resolve path: ${pathOrGlob}`);
        return;
      }

      if (files.length === 0) {
        die(`No markdown files found at: ${pathOrGlob}`);
      }

      const existing = new Set(listIdentities(process.cwd()));
      let imported = 0;
      let skipped = 0;

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        try {
          const raw = fs.readFileSync(file, "utf-8");
          const frontmatter = parseIdentityFrontmatter(raw);

          if (existing.has(frontmatter.name)) {
            console.log(`  ${c.dim}skip${c.reset}  ${frontmatter.name} (already exists)`);
            skipped++;
            continue;
          }

          const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1].trim() : "";

          const ident = {
            name: frontmatter.name,
            description: frontmatter.description,
            expertise: frontmatter.expertise ?? [],
            vibe: frontmatter.vibe ?? "",
            content: body,
            emoji: frontmatter.emoji,
            color: frontmatter.color,
          };

          saveIdentity(ident, process.cwd());
          existing.add(frontmatter.name);
          console.log(`  ${c.green}import${c.reset}  ${frontmatter.name}`);
          imported++;
        } catch (err: any) {
          console.log(`  ${c.red}error${c.reset}  ${path.basename(file)}: ${err.message}`);
        }
      }

      console.log(`\nImported ${imported} identit${imported === 1 ? "y" : "ies"}, skipped ${skipped} (already exist).`);
    });
}
