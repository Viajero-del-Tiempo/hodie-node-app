module.exports = {
  apps: [{
    name: "hodie-backend",
    script: "./server.js",
    cwd: __dirname,
    kill_timeout: 15000,
    time: true,
  }],
};
