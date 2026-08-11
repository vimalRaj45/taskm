import dotenv from 'dotenv';

dotenv.config();

export interface AnalyzedEmail {
  id: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  importance: 'Urgent' | 'High' | 'Medium' | 'Low';
  importanceScore: number; // 1 - 100
  summary: string;
  keyTakeaways: string[];
  actionableTask: {
    title: string;
    priority: 'Urgent' | 'High' | 'Medium' | 'Low';
    dueDate?: string;
  } | null;
  isRead: boolean;
  category: 'Work' | 'Client' | 'Security' | 'Newsletter' | 'General';
}

export interface EmailDigestResponse {
  summary: {
    totalEmails: number;
    urgentCount: number;
    highCount: number;
    actionableCount: number;
    overview: string;
  };
  emails: AnalyzedEmail[];
  isMock: boolean;
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/emails/callback';

export function getGoogleOAuthUrl(): string {
  if (!GOOGLE_CLIENT_ID) {
    // Demo OAuth URL if credentials are not configured yet
    const params = new URLSearchParams({
      client_id: 'demo_google_client_id.apps.googleusercontent.com',
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{ access_token: string; refresh_token?: string }> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    // Return mock OAuth tokens for testing environment
    return {
      access_token: `mock_access_token_${Date.now()}`,
      refresh_token: `mock_refresh_token_${Date.now()}`,
    };
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google OAuth Token Exchange failed: ${errorText}`);
  }

  return response.json();
}

/**
 * Main function to fetch daily emails and analyze them for importance order using AI.
 */
export async function getDailyEmailsWithImportance(accessToken?: string | null): Promise<EmailDigestResponse> {
  let rawEmails: Array<{
    id: string;
    sender: string;
    senderEmail: string;
    subject: string;
    date: string;
    snippet: string;
    body: string;
  }> = [];

  if (accessToken && !accessToken.startsWith('mock_')) {
    try {
      rawEmails = await fetchGmailMessagesFromAPI(accessToken);
    } catch (err) {
      console.warn('Failed to fetch from Gmail API with access token:', err);
      return {
        summary: {
          totalEmails: 0,
          urgentCount: 0,
          highCount: 0,
          actionableCount: 0,
          overview: 'Failed to connect to Gmail API. Please re-authorize your Google Account.',
        },
        emails: [],
        isMock: false,
      };
    }
  } else {
    return {
      summary: {
        totalEmails: 0,
        urgentCount: 0,
        highCount: 0,
        actionableCount: 0,
        overview: 'Google Account not connected. Click "Authorize Google OAuth" above to connect your Gmail inbox.',
      },
      emails: [],
      isMock: false,
    };
  }

  // Process raw emails through AI importance analyzer
  const analyzedEmails = await analyzeEmailsWithAI(rawEmails);

  // Sort emails strictly by importance score descending (highest score first)
  analyzedEmails.sort((a, b) => b.importanceScore - a.importanceScore);

  // Compute summary metrics
  const urgentCount = analyzedEmails.filter((e) => e.importance === 'Urgent').length;
  const highCount = analyzedEmails.filter((e) => e.importance === 'High').length;
  const actionableCount = analyzedEmails.filter((e) => e.actionableTask !== null).length;

  const overview = `Today's live Gmail digest contains ${analyzedEmails.length} emails. ${urgentCount} urgent item(s) require immediate attention and ${actionableCount} item(s) are ready to convert into action tasks.`;

  return {
    summary: {
      totalEmails: analyzedEmails.length,
      urgentCount,
      highCount,
      actionableCount,
      overview,
    },
    emails: analyzedEmails,
    isMock: false,
  };
}

async function fetchGmailMessagesFromAPI(accessToken: string) {
  const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=category:primary', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    throw new Error('Gmail API list messages request failed');
  }

  const listData = await listRes.json();
  const messages: any[] = listData.messages || [];

  const fetched = await Promise.all(
    messages.slice(0, 8).map(async (msg) => {
      const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!detailRes.ok) return null;
      const detail = await detailRes.json();

      const headers = detail.payload?.headers || [];
      const subjectHeader = headers.find((h: any) => h.name.toLowerCase() === 'subject');
      const fromHeader = headers.find((h: any) => h.name.toLowerCase() === 'from');
      const dateHeader = headers.find((h: any) => h.name.toLowerCase() === 'date');

      const subject = subjectHeader ? subjectHeader.value : 'No Subject';
      const fromRaw = fromHeader ? fromHeader.value : 'Unknown Sender';
      const snippet = detail.snippet || '';

      const senderMatch = fromRaw.match(/(.*)<(.*)>/);
      const sender = senderMatch ? senderMatch[1].trim().replace(/^"|"$/g, '') : fromRaw;
      const senderEmail = senderMatch ? senderMatch[2].trim() : fromRaw;

      return {
        id: detail.id,
        sender: sender || senderEmail,
        senderEmail,
        subject,
        date: dateHeader ? new Date(dateHeader.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Today',
        snippet,
        body: snippet,
      };
    })
  );

  return fetched.filter(Boolean) as Array<{
    id: string;
    sender: string;
    senderEmail: string;
    subject: string;
    date: string;
    snippet: string;
    body: string;
  }>;
}

async function analyzeEmailsWithAI(
  rawEmails: Array<{
    id: string;
    sender: string;
    senderEmail: string;
    subject: string;
    date: string;
    snippet: string;
    body: string;
  }>
): Promise<AnalyzedEmail[]> {
  const apiKey = process.env.MISTRAL_API_KEY;

  if (apiKey && !apiKey.includes('your_mistral_api_key')) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are an AI Daily Email Prioritizer & Executive Assistant.
Analyze each email in the input list and output a JSON array of analyzed objects under the key "emails".

For each email, score its importance (1-100) based on urgency, deadline pressure, client impact, or action items required.
Classify importance as:
- 'Urgent': Score 85-100 (Immediate client requests, server down alerts, urgent review needed today)
- 'High': Score 65-84 (Important project updates, meeting requests, client inquiries)
- 'Medium': Score 40-64 (General internal team notes, weekly summaries)
- 'Low': Score 1-39 (Newsletters, automated receipts, promotional updates)

RETURN FORMAT (Strict JSON):
{
  "emails": [
    {
      "id": "email_id",
      "importance": "Urgent" | "High" | "Medium" | "Low",
      "importanceScore": 95,
      "summary": "Brief 1-sentence AI summary of the email",
      "keyTakeaways": ["Takeaway 1", "Takeaway 2"],
      "actionableTask": {
        "title": "Action task title to solve this email",
        "priority": "Urgent" | "High" | "Medium" | "Low"
      },
      "category": "Work" | "Client" | "Security" | "Newsletter" | "General"
    }
  ]
}`,
            },
            {
              role: 'user',
              content: JSON.stringify(rawEmails),
            },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const rawContent = data.choices?.[0]?.message?.content;
        if (rawContent) {
          const parsed = JSON.parse(rawContent);
          const aiEmailsList: any[] = parsed.emails || [];

          return rawEmails.map((raw) => {
            const aiMatch = aiEmailsList.find((item) => item.id === raw.id) || {};
            const importance = aiMatch.importance || calculateImportanceRule(raw.subject, raw.snippet).importance;
            const importanceScore = aiMatch.importanceScore || calculateImportanceRule(raw.subject, raw.snippet).importanceScore;

            return {
              id: raw.id,
              sender: raw.sender,
              senderEmail: raw.senderEmail,
              subject: raw.subject,
              date: raw.date,
              snippet: raw.snippet,
              body: raw.body,
              importance,
              importanceScore,
              summary: aiMatch.summary || raw.snippet,
              keyTakeaways: aiMatch.keyTakeaways || [raw.snippet.slice(0, 60)],
              actionableTask: aiMatch.actionableTask || (importance === 'Urgent' || importance === 'High' ? { title: `Follow up: ${raw.subject}`, priority: importance } : null),
              isRead: false,
              category: aiMatch.category || 'Work',
            };
          });
        }
      }
    } catch (err) {
      console.warn('Mistral AI Email Analysis call failed, using Rule-Based Engine fallback:', err);
    }
  }

  // Smart Rule-Based Engine Fallback
  return rawEmails.map((raw) => {
    const ruleResult = calculateImportanceRule(raw.subject, raw.snippet);
    return {
      id: raw.id,
      sender: raw.sender,
      senderEmail: raw.senderEmail,
      subject: raw.subject,
      date: raw.date,
      snippet: raw.snippet,
      body: raw.body,
      importance: ruleResult.importance,
      importanceScore: ruleResult.importanceScore,
      summary: ruleResult.summary,
      keyTakeaways: ruleResult.keyTakeaways,
      actionableTask: ruleResult.actionableTask,
      isRead: false,
      category: ruleResult.category,
    };
  });
}

function calculateImportanceRule(subject: string, snippet: string): {
  importance: 'Urgent' | 'High' | 'Medium' | 'Low';
  importanceScore: number;
  summary: string;
  keyTakeaways: string[];
  actionableTask: { title: string; priority: 'Urgent' | 'High' | 'Medium' | 'Low' } | null;
  category: 'Work' | 'Client' | 'Security' | 'Newsletter' | 'General';
} {
  const combined = (subject + ' ' + snippet).toLowerCase();

  if (combined.includes('urgent') || combined.includes('asap') || combined.includes('critical') || combined.includes('security alert') || combined.includes('production issue')) {
    return {
      importance: 'Urgent',
      importanceScore: 95,
      summary: `Urgent action required: ${subject}. Requires immediate response or fix.`,
      keyTakeaways: ['Requires immediate review', 'Potential impact on production or deadline'],
      actionableTask: { title: `[URGENT] ${subject.replace(/fwd:|re:/gi, '').trim()}`, priority: 'Urgent' },
      category: combined.includes('security') ? 'Security' : 'Client',
    };
  }

  if (combined.includes('review') || combined.includes('feedback') || combined.includes('client') || combined.includes('proposal') || combined.includes('deadline') || combined.includes('approval')) {
    return {
      importance: 'High',
      importanceScore: 78,
      summary: `High priority item: ${subject}. Client or team feedback requested.`,
      keyTakeaways: ['Review requested deliverables', 'Action required before end of day'],
      actionableTask: { title: `Review: ${subject.replace(/fwd:|re:/gi, '').trim()}`, priority: 'High' },
      category: 'Client',
    };
  }

  if (combined.includes('meeting') || combined.includes('standup') || combined.includes('update') || combined.includes('notes') || combined.includes('sync')) {
    return {
      importance: 'Medium',
      importanceScore: 55,
      summary: `Internal update: ${subject}. Information for team alignment.`,
      keyTakeaways: ['Meeting notes and key decisions', 'Sync scheduled for this week'],
      actionableTask: { title: `Prepare notes for ${subject}`, priority: 'Medium' },
      category: 'Work',
    };
  }

  return {
    importance: 'Low',
    importanceScore: 25,
    summary: `Informational update: ${subject}. No immediate action required.`,
    keyTakeaways: ['Informational newsletter or system receipt'],
    actionableTask: null,
    category: combined.includes('newsletter') || combined.includes('digest') ? 'Newsletter' : 'General',
  };
}
