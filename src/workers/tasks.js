// Tasks are lightweight, fire-and-forget functions run in the background.
// Unlike Jobs, tasks are not tracked in the database.
// See src/extensions/job-runners/README.md for more details
import serviceMap from "../extensions/service-vendors";
import * as ActionHandlers from "../extensions/action-handlers";
import { r, cacheableData } from "../server/models";
import { Notifications, sendUserNotification } from "../server/notifications";
import { processServiceManagers } from "../extensions/service-managers";

export const Tasks = Object.freeze({
  SEND_MESSAGE: "send_message",
  ACTION_HANDLER_QUESTION_RESPONSE: "action_handler:question_response",
  ACTION_HANDLER_TAG_UPDATE: "action_handler:tag_update",
  CAMPAIGN_START_CACHE: "campaign_start_cache",
  SERVICE_MANAGER_TRIGGER: "service_manager_trigger"
});

const serviceManagerTrigger = async ({
  functionName,
  organizationId,
  data
}) => {
  let organization;
  if (organizationId) {
    organization = await cacheableData.organization.load(organizationId);
  }
  const serviceManagerData = await processServiceManagers(
    functionName,
    organization,
    data
  );

  // This is a little hacky rather than making another task, but while it's a single
  // exception, it feels fine -- if this becomes a bunch of if...else ifs, then reconsider
  if (
    functionName === "onCampaignStart" &&
    data.campaign &&
    !(serviceManagerData && serviceManagerData.blockCampaignStart)
  ) {
    await r
      .knex("campaign")
      .where("id", data.campaign.id)
      .update({ is_started: true });
    await cacheableData.campaign.load(data.campaign.id, { forceLoad: true });
    await sendUserNotification({
      type: Notifications.CAMPAIGN_STARTED,
      campaignId: data.campaign.id
    });
    // TODO: Decide if we want/need this anymore, relying on FUTURE campaign-contact cache load changes
    // We are already in an background job process, so invoke the task directly rather than
    // kicking it off through the dispatcher
    // await invokeTaskFunction(Tasks.CAMPAIGN_START_CACHE, {
    //   organization,
    //   campaign: reloadedCampaign
    // });
  }
};

const sendMessage = async ({
  message,
  contact,
  trx,
  organization,
  campaign
}) => {
  const service = serviceMap[message.service];
  if (!service) {
    throw new Error(`Failed to find service for message ${message}`);
  }
  const serviceManagerData = await processServiceManagers(
    "onMessageSend",
    organization,
    { message, contact, campaign }
  );

  await service.sendMessage({
    message,
    contact,
    trx,
    organization,
    campaign,
    serviceManagerData
  });
};

const questionResponseActionHandler = async ({
  name,
  organization,
  questionResponse,
  interactionStep,
  campaign,
  contact,
  wasDeleted,
  previousValue
}) => {
  const handler = await ActionHandlers.rawActionHandler(name);

  if (!wasDeleted) {
    // TODO: clean up processAction interface
    return handler.processAction({
      questionResponse,
      interactionStep,
      campaignContactId: contact.id,
      contact,
      campaign,
      organization,
      previousValue
    });
  } else if (
    handler.processDeletedQuestionResponse &&
    typeof handler.processDeletedQuestionResponse === "function"
  ) {
    return handler.processDeletedQuestionResponse({
      questionResponse,
      interactionStep,
      campaignContactId: contact.id,
      contact,
      campaign,
      organization,
      previousValue
    });
  }
};

const tagUpdateActionHandler = async ({
  name,
  tags,
  contact,
  campaign,
  organization,
  texter
}) => {
  const handler = await ActionHandlers.rawActionHandler(name);
  await handler.onTagUpdate(tags, contact, campaign, organization, texter);
};

const startCampaignCache = async ({ campaign, organization }, contextVars) => {
  // Refresh all the campaign data into cache
  // This should refresh/clear any corruption
  const loadAssignments = cacheableData.campaignContact.updateCampaignAssignmentCache(
    campaign.id
  );
  const loadContacts = cacheableData.campaignContact
    .loadMany(campaign, organization, contextVars || {})
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("FINISHED contact loadMany", campaign.id);
    })
    .catch(err => {
      // eslint-disable-next-line no-console
      console.error("ERROR contact loadMany", campaign.id, err, campaign);
    });
  const loadOptOuts = cacheableData.optOut.loadMany(organization.id);

  await loadAssignments;
  await loadContacts;
  await loadOptOuts;
};

const taskMap = Object.freeze({
  [Tasks.SEND_MESSAGE]: sendMessage,
  [Tasks.ACTION_HANDLER_QUESTION_RESPONSE]: questionResponseActionHandler,
  [Tasks.ACTION_HANDLER_TAG_UPDATE]: tagUpdateActionHandler,
  [Tasks.CAMPAIGN_START_CACHE]: startCampaignCache,
  [Tasks.SERVICE_MANAGER_TRIGGER]: serviceManagerTrigger
});

export const invokeTaskFunction = async (taskName, payload) => {
  if (taskName in taskMap) {
    await taskMap[taskName](payload);
  } else {
    throw new Error(`Task of type ${taskName} not found`);
  }
};
