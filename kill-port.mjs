import { exec } from "node:child_process";

export function killPort(port = 3000) {
  return new Promise((resolve) => {
    exec(`lsof -t -i:${port}`, (error, stdout) => {
      if (error || !stdout) {
        console.log(`No process is using port ${port}`);
        return resolve();
      }

      const pids = stdout
        .split("\n")
        .map((pid) => pid.trim())
        .filter(Boolean);

      console.log(`Killing port ${port}:`, pids.join(", "));

      pids.forEach((pid) => {
        try {
          process.kill(pid, "SIGKILL");
          console.log(`Killed PID ${pid}`);
        } catch (err) {
          console.error(`Failed to kill PID ${pid}:`, err.message);
        }
      });

      resolve();
    });
  });
}
