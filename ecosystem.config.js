module.exports = {
  apps: [{
    name: "sara-stg-dev",
    cwd: "/home/azureuser/sara",
    script: "npm",
    args: "run stg",
    env: {
      NODE_ENV: "development",
      APP_ENV: "stg",
      PORT: "3000"
    },
    watch: false,
    out_file: "./logs/out.log",
    error_file: "./logs/err.log",
    merge_logs: true,
  }]
};
