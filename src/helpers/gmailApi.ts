import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import Logger from "../logger";

interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  emailId?: string; // Add emailId to save updated tokens back to database
}

interface EmailSearchResult {
  id: string;
  threadId: string;
  subject?: string;
  snippet?: string;
}

export class GmailApiService {
  private oauth2Client: OAuth2Client;
  private gmail: any;
  private emailId?: string;
  private fromEmail: string;

  constructor(credentials: GmailCredentials) {
    this.emailId = credentials.emailId;
    this.fromEmail = credentials.emailId || "me";

    this.oauth2Client = new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret,
      "urn:ietf:wg:oauth:2.0:oob" // redirect URI for installed apps
    );

    this.oauth2Client.setCredentials({
      refresh_token: credentials.refreshToken,
      access_token: credentials.accessToken,
    });

    this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });
  }

  /**
   * Search for emails in the spam folder by subject
   */
  async searchEmailsInSpam(subject: string): Promise<EmailSearchResult[]> {
    try {
      Logger.info(
        `[GmailAPI] Searching for emails in spam with subject: ${subject}`
      );

      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: `in:spam subject:"${subject}"`,
        maxResults: 10,
      });

      if (!response.data.messages || response.data.messages.length === 0) {
        Logger.info(
          `[GmailAPI] No emails found in spam with subject: ${subject}`
        );
        return [];
      }

      const emailDetails: EmailSearchResult[] = [];

      // Get details for each message
      for (const message of response.data.messages) {
        try {
          const messageDetails = await this.gmail.users.messages.get({
            userId: "me",
            id: message.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "To"],
          });

          const headers = messageDetails.data.payload?.headers || [];
          const subjectHeader = headers.find((h: any) => h.name === "Subject");

          emailDetails.push({
            id: message.id,
            threadId: message.threadId,
            subject: subjectHeader?.value,
            snippet: messageDetails.data.snippet,
          });
        } catch (error) {
          Logger.error(
            `[GmailAPI] Error getting message details for ${message.id}:`,
            { error }
          );
        }
      }

      Logger.info(`[GmailAPI] Found ${emailDetails.length} emails in spam`);
      return emailDetails;
    } catch (error) {
      Logger.criticalError(
        "[GmailAPI] Error searching emails in spam",
        {
          action: "Search Emails in Spam",
          subject,
          error,
        },
        [
          "Check Gmail API credentials",
          "Verify API permissions",
          "Check quota limits",
        ]
      );
      throw error;
    }
  }

  /**
   * Mark emails as not spam (remove from spam folder and move to inbox)
   * This properly trains Gmail's spam filter
   */
  async markEmailsAsNotSpam(messageIds: string[]): Promise<boolean> {
    try {
      if (messageIds.length === 0) {
        Logger.info("[GmailAPI] No emails to mark as not spam");
        return true;
      }

      Logger.info(
        `[GmailAPI] Marking ${messageIds.length} email(s) as not spam`
      );

      // Remove SPAM label and add INBOX label
      const batchModifyRequest = {
        userId: "me",
        resource: {
          ids: messageIds,
          removeLabelIds: ["SPAM"],
          addLabelIds: ["INBOX"],
        },
      };

      await this.gmail.users.messages.batchModify(batchModifyRequest);

      Logger.info(
        `✅ Successfully marked ${messageIds.length} email(s) as not spam`
      );
      return true;
    } catch (error) {
      Logger.criticalError(
        "[GmailAPI] Error marking emails as not spam",
        {
          action: "Mark Emails as Not Spam",
          messageCount: messageIds.length,
          error,
        },
        [
          "Check Gmail API credentials",
          "Verify API permissions",
          "Check quota limits",
        ]
      );
      return false;
    }
  }

  /**
   * Check if emails with specific subject are in spam and mark them as not spam
   */
  async checkAndFixSpamEmails(
    subject: string
  ): Promise<{ found: boolean; processed: number }> {
    try {
      // Search for emails in spam
      const spamEmails = await this.searchEmailsInSpam(subject);

      if (spamEmails.length === 0) {
        return { found: false, processed: 0 };
      }

      // Filter emails that actually match the subject (exact or contains)
      const matchingEmails = spamEmails.filter(
        (email) => email.subject && email.subject.includes(subject)
      );

      if (matchingEmails.length === 0) {
        Logger.info(
          `[GmailAPI] No matching emails found in spam for subject: ${subject}`
        );
        return { found: false, processed: 0 };
      }

      Logger.info(
        `[GmailAPI] Found ${matchingEmails.length} matching email(s) in spam. Marking as not spam...`
      );

      // Mark emails as not spam
      const messageIds = matchingEmails.map((email) => email.id);
      const success = await this.markEmailsAsNotSpam(messageIds);

      return {
        found: true,
        processed: success ? matchingEmails.length : 0,
      };
    } catch (error) {
      Logger.criticalError(
        "[GmailAPI] Error in checkAndFixSpamEmails",
        {
          action: "Check and Fix Spam Emails",
          subject,
          error,
        },
        ["Check Gmail API setup", "Verify credentials"]
      );
      return { found: false, processed: 0 };
    }
  }

  /**
   * Send email reply using Gmail API
   */
  async sendReply(
    to: string,
    subject: string,
    body: string,
    inReplyTo?: string,
    references?: string
  ): Promise<boolean> {
    try {
      Logger.info(
        `[GmailAPI] Sending email reply to ${to} with subject: ${subject}`
      );

      // Refresh access token if needed
      await this.refreshAccessToken();

      // Create email message in RFC 2822 format
      const emailLines = [
        `To: ${to}`,
        `From: ${this.fromEmail}`,
        `Subject: Re: ${subject}`,
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
        ...(references ? [`References: ${references}`] : []),
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body,
      ];

      const email = emailLines.join("\r\n");

      // Encode email in base64url format
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send email using Gmail API
      const response = await this.gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedEmail,
        },
      });

      if (response.data.id) {
        Logger.info(
          `[GmailAPI] Successfully sent email reply. Message ID: ${response.data.id}`
        );
        return true;
      } else {
        Logger.error(
          "[GmailAPI] Failed to send email - no message ID returned"
        );
        return false;
      }
    } catch (error) {
      Logger.criticalError(
        "[GmailAPI] Error sending email reply",
        {
          action: "Send Email Reply",
          to,
          subject,
          error,
        },
        [
          "Check Gmail API credentials",
          "Verify API permissions",
          "Check quota limits",
        ]
      );
      return false;
    }
  }

  /**
   * Refresh access token if needed and save to database
   */
  async refreshAccessToken(): Promise<void> {
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.oauth2Client.setCredentials(credentials);

      // Save updated access token to database if emailId is available
      if (this.emailId && credentials.access_token) {
        try {
          const { updateGmailAccessToken } = await import("./database");
          await updateGmailAccessToken(this.emailId, credentials.access_token);
          Logger.info(
            `[GmailAPI] Access token refreshed and saved to database for ${this.emailId}`
          );
        } catch (dbError) {
          Logger.error(
            "[GmailAPI] Failed to save refreshed token to database",
            {
              emailId: this.emailId,
              error: dbError,
            }
          );
          // Don't throw here - token refresh was successful, just DB save failed
        }
      } else {
        Logger.info("[GmailAPI] Access token refreshed successfully");
      }
    } catch (error) {
      Logger.criticalError(
        "[GmailAPI] Error refreshing access token",
        {
          action: "Refresh Access Token",
          emailId: this.emailId,
          error,
        },
        ["Check refresh token validity", "Verify OAuth2 setup"]
      );
      throw error;
    }
  }
}
