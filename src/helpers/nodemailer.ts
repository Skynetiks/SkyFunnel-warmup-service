import nodemailer, { Transporter } from "nodemailer";
import Mail from "nodemailer/lib/mailer/index";
import { CONFIGURATIONS } from "../data/mail-configuration";


export const getNodemailerTransport = (replyFrom:string): Transporter => {
  // Get the current configuration
  const config = CONFIGURATIONS.find(config => config.user === replyFrom) || CONFIGURATIONS[0];

  // Create a nodemailer transport based on the current configuration
  const transport = nodemailer.createTransport({
    service: config.service,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  return transport;
};


/**
 * Helper function to send an email.
 * @param {string} to - Recipient email address.
 * @param {string} subject - Subject of the email.
 * @param {string} text - Body text of the email.
 */
export async function sendEmail(to: string, subject: string,body:string , text: string,inReplyTo:string, referenceId:string, replyFrom:string): Promise<void> {
  const mailOptions = {
    from: replyFrom,
    to,
    subject: `${subject}`,
    text: body,
    references:[referenceId],
    inReplyTo: inReplyTo,
  } satisfies Mail.Options
  
  const transport = getNodemailerTransport(replyFrom);

  await transport.sendMail(mailOptions);
}
