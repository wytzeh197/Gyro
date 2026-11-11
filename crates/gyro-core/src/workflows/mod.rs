//! Portable recipes are data. Execution bindings and approval remain local.
mod artifacts;
mod checkout;
pub use checkout::WorkflowCheckoutLease;
mod definition;
mod template;
mod types;
pub use artifacts::{
    delete_draft_output, open_draft_partial, read_draft_output, remove_draft_partial,
    write_draft_output,
};
pub use definition::{
    definition_hash, parse_definition, plan_definition_write, read_definitions,
    validate_definition, validate_inputs, DefinitionWritePlan, WorkflowListing,
};
pub use template::{parse_template, render_text_input, TemplatePart};
pub use types::*;
#[cfg(test)]
mod tests;
