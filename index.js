const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const User = require("@saltcorn/data/models/user");
const Table = require("@saltcorn/data/models/table");
const Field = require("@saltcorn/data/models/field");
const Trigger = require("@saltcorn/data/models/trigger");
const Stripe = require("stripe");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const success = require("./success");
const subscribe = require("./subscribe");
const portal = require("./portal");
const one_time = require("./one_time");
const { upgrade_with_session_id } = require("./common");

const getLegacyInactiveRoleId = (roles) => {
  const roleIds = new Set(roles.map((role) => Number(role.id)));

  if (roleIds.has(8)) return 8;
  if (roleIds.has(80)) return 80;

  return null;
};

const ensureField = async (table, fieldSpec) => {
  const existingField = table
    .getFields()
    .find((field) => field.name === fieldSpec.name);

  if (existingField) return existingField;

  return Field.create({
    ...fieldSpec,
    table,
  });
};

const ensureTable = async ({ name, fields }) => {
  let table = Table.findOne({ name });

  if (!table) {
    table = await Table.create(name, {
      min_role_read: 1,
      min_role_write: 1,
    });
  }

  for (const field of fields) {
    await ensureField(table, field);
  }

  return table;
};

const ensureStripeTables = async () => {
  await ensureTable({
    name: "stripe_events",
    fields: [
      {
        name: "event_id",
        label: "Stripe event ID",
        type: "String",
        required: true,
        is_unique: true,
      },
      {
        name: "event_type",
        label: "Event type",
        type: "String",
        required: true,
      },
      {
        name: "payload",
        label: "Payload",
        type: "JSON",
      },
      {
        name: "processed",
        label: "Processed",
        type: "Bool",
        required: true,
      },
      {
        name: "processing_error",
        label: "Processing error",
        type: "String",
      },
      {
        name: "trigger_name",
        label: "Trigger name",
        type: "String",
      },
      {
        name: "trigger_ran",
        label: "Trigger ran",
        type: "Bool",
        required: true,
      },
      {
        name: "trigger_ran_at",
        label: "Trigger ran at",
        type: "Date",
      },
      {
        name: "trigger_error",
        label: "Trigger error",
        type: "String",
      },
    ],
  });

  await getState().refresh_tables();
};

const configuration_workflow = () => {
  const cfg_base_url = getState().getConfig("base_url");

  return new Workflow({
    steps: [
      {
        name: "Stripe configuration",
        form: async () => {
          const roles = await User.get_roles();
          const legacyRoleId = getLegacyInactiveRoleId(roles);
          const roleOptions = roles
            .filter((role) => Number(role.id) !== legacyRoleId)
            .map((role) => ({
              value: role.id,
              label: `${role.role} (role ${role.id})`,
            }));


          const legacyOption = legacyRoleId
            ? {
              value: legacyRoleId,
              label: `Legacy default: role ${legacyRoleId}`,
            }
            : null;


          return new Form({
            labelCols: 3,
            blurb: !cfg_base_url
              ? "You should set the 'Base URL' configuration property. "
              : "",
            fields: [
              {
                name: "public_api_key",
                label: "Publishable API key",
                type: "String",
                required: true,
              },
              {
                name: "api_key",
                label: "Secret API key",
                type: "String",
                required: true,
              },
              {
                name: "webhook_signing_secret",
                label: "Webhook signing secret",
                sublabel:
                  "Enable a 'stripe_webhook' as an 'API call' action.",
                type: "String",
                required: true,
              },
              {
                name: "inactive_role_id",
                label: "Inactive subscription role",
                input_type: "select",
                required: true,
                options: [
                  ...(legacyOption ? [legacyOption] : []),
                  ...roleOptions,
                ],
                sublabel:
                  "Used after cancellation or payment failure. Existing installations without a saved value will retain the legacy role 8 behavior.",
              },
            ],
          });
        },
      },
    ],
  });
};

const sessionCompleted = async (event, eventRecord) => {
  const session_id = event.data.object.id;
  const customer = event.data.object.customer;
  const schemaPrefix = db.getTenantSchemaPrefix();

  const result = await db.query(
    `select * from ${schemaPrefix}users where _attributes->'stripe_sessions'->'${db.sqlsanitize(
      session_id
    )}' is not null`
  );

  const user = result.rows[0];

  if (user) {
    await upgrade_with_session_id({
      user: new User(user),
      session_id,
      customer,
      response: event,
    });
  }

  await executeSessionTrigger({
    event,
    eventRecord,
  });
};

const cancelSubscription = async (event, inactive_role_id) => {
  const customer = event.data.object.customer;
  const user = await User.findOne({
    _attributes: { json: ["stripe_customer", customer] },
  });

  if (user) {
    const configuredRoleId = Number(inactive_role_id);
    const roleId = configuredRoleId || 8;

    await user.update({ role_id: roleId });
  }
};

// user subscribe action
const actions = ({ api_key, webhook_signing_secret, inactive_role_id }) => {
  const stripe = Stripe(api_key);
  return {
    stripe_webhook: {
      run: async ({ req, body }) => {
        let event;
        let eventRecord;
        try {
          if (webhook_signing_secret) {
            const sig = req.headers["stripe-signature"];
            event = stripe.webhooks.constructEvent(
              req.rawBody,
              sig,
              webhook_signing_secret
            );
          } else {
            event = body;
          }
          eventRecord = await recordStripeEvent(event);
          switch (event.type) {
            case "checkout.session.completed":
              await sessionCompleted(event, eventRecord);
              break;
            case "customer.subscription.deleted":
            case "invoice.payment_failed":
              await cancelSubscription(event, inactive_role_id);
              break;

            default:
              console.log(`Unhandled event type ${event.type}`);
          }
          const eventsTable = Table.findOne({
            name: "stripe_events",
          });
          await eventsTable.updateRow(
            {
              processed: true,
              processing_error: null,
            },
            eventRecord.row.id
          );
          return { received: true };
        } catch (error) {
          if (eventRecord?.row?.id) {
            const eventsTable = Table.findOne({
              name: "stripe_events",
            });
            await eventsTable.updateRow(
              {
                processing_error: error.message,
              },
              eventRecord.row.id
            );
          }
          throw error;
        }
      },
    },
  };
};

const recordStripeEvent = async (event) => {
  const eventsTable = Table.findOne({
    name: "stripe_events",
  });

  const existingRows = await eventsTable.getRows(
    {
      event_id: event.id,
    },
    {
      limit: 1,
    }
  );

  if (existingRows.length > 0) {
    return {
      row: existingRows[0],
      isNew: false,
    };
  }

  const rowId = await eventsTable.insertRow({
    event_id: event.id,
    event_type: event.type,
    payload: event,
    processed: false,
    trigger_ran: false,
  });

  const insertedRow = await eventsTable.getRow({
    id: rowId,
  });

  if (!insertedRow) {
    throw new Error(
      `Stripe event row could not be reloaded after insert: ${rowId}`
    );
  }

  return {
    row: insertedRow,
    isNew: true,
  };
};


const executeSessionTrigger = async ({ event, eventRecord }) => {
  const session = event.data.object;
  const metadata = session.metadata || {};
  const triggerName = metadata.saltcorn_success_trigger;

  if (!triggerName) return;

  if (eventRecord.row.trigger_ran) return;

  const eventsTable = Table.findOne({
    name: "stripe_events",
  });

  try {
    const triggerRows = await Trigger.findDB({
      name: triggerName,
    });

    const trigger = triggerRows[0];

    if (!trigger) {
      throw new Error(`Configured Stripe Trigger not found: ${triggerName}`);
    }

    if (
      trigger.when_trigger !== "Never" ||
      trigger.action === "Workflow"
    ) {
      throw new Error(
        `Configured Stripe Trigger is not an allowed callable Trigger: ${triggerName}`
      );
    }

    const userId = metadata.saltcorn_user_id
      ? Number(metadata.saltcorn_user_id)
      : undefined;

    const user = userId
      ? await User.findOne({ id: userId })
      : undefined;

    const triggerRow = {
      id: session.id,
      checkout_session_id: session.id,
      event_id: event.id,
      user_id: userId,
      mode: session.mode,
      customer_id: session.customer,
      subscription_id: session.subscription,
      price_id: metadata.saltcorn_price_id,
      product_id: metadata.saltcorn_product_id,
      trigger_name: triggerName,
      payload: session,
      stripe_event: event,
      stripe_session: session,
    };

    await eventsTable.updateRow(
      {
        trigger_name: triggerName,
      },
      eventRecord.row.id
    );

    await trigger.runWithoutRow({
      user,
      row: triggerRow,
    });

    await eventsTable.updateRow(
      {
        trigger_name: triggerName,
        trigger_ran: true,
        trigger_ran_at: new Date(),
        trigger_error: null,
      },
      eventRecord.row.id
    );
  } catch (error) {
    await eventsTable.updateRow(
      {
        trigger_name: triggerName,
        trigger_ran: false,
        trigger_error: error.message,
      },
      eventRecord.row.id
    );

    throw error;
  }
};

const viewtemplates = (config) => {
  const stripe = Stripe(config.api_key);

  return [
    subscribe(config, stripe),
    success(config, stripe),
    portal(config, stripe),
    one_time(config, stripe),
  ];
};

module.exports = {
  sc_plugin_api_version: 1,
  onLoad: ensureStripeTables,
  configuration_workflow,
  actions,
  viewtemplates,
  table_providers: require("./table-provider.js"),
  functions: (config) => ({ get_stripe: () => Stripe(config.api_key) }),
};
