import "dotenv/config";

const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;
const ADO_API_VERSION = process.env.ADO_API_VERSION ?? "7.1";

const auth = Buffer.from(`:${ADO_PAT}`).toString("base64");

async function adoRequest(path, options = {}) {
  const url = `https://dev.azure.com/${encodeURIComponent(ADO_ORG)}/${encodeURIComponent(ADO_PROJECT)}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(options.headers ?? {})
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${JSON.stringify(body, null, 2)}`);
  }

  return body;
}

const wiql = `
SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType]
FROM WorkItems
WHERE [System.TeamProject] = @project
ORDER BY [System.ChangedDate] DESC
`;

const result = await adoRequest(`/_apis/wit/wiql?$top=5&api-version=${ADO_API_VERSION}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: wiql })
});

console.log(JSON.stringify(result, null, 2));