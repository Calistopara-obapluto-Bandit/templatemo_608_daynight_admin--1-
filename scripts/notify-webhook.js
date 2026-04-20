const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
const status = process.argv[2] || 'unknown';

if (!webhookUrl) {
  console.log('NOTIFY_WEBHOOK_URL is not set; skipping notification.');
  process.exit(0);
}

const payload = {
  status,
  project: 'Godstime Lodge',
  repository: process.env.CIRCLE_PROJECT_REPONAME,
  workflow_id: process.env.CIRCLE_WORKFLOW_ID,
  workflow_name: process.env.CIRCLE_WORKFLOW_NAME,
  job: process.env.CIRCLE_JOB,
  branch: process.env.CIRCLE_BRANCH,
  commit: process.env.CIRCLE_SHA1,
  build_url: process.env.CIRCLE_BUILD_URL,
  timestamp: new Date().toISOString(),
};

async function main() {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    console.error(
      `Webhook request failed with ${response.status} ${response.statusText}${
        responseBody ? `: ${responseBody}` : ''
      }`
    );
    return;
  }

  console.log(`Notification sent for ${status}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(0);
});
