const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const User = require("@saltcorn/data/models/user");
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

const sessionCompleted = async (event) => {
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
        switch (event.type) {
          case "checkout.session.completed":
            await sessionCompleted(event, stripe);
            break;
          case "customer.subscription.deleted":
          case "invoice.payment_failed":
            await cancelSubscription(event, inactive_role_id);
            break;

          default:
            console.log(`Unhandled event type ${event.type}`);
        }
        return { received: true };
      },
    },
  };
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
  configuration_workflow,
  actions,
  viewtemplates,
  table_providers: require("./table-provider.js"),
  functions: (config) => ({ get_stripe: () => Stripe(config.api_key) }),
};
