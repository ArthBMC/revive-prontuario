module.exports = {
  apps: [
    {
      name: 'prontuarios-app',
      script: 'server/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
