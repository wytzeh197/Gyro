//! Cursor's blocking inputs become Gyro chat questions. The ACP request is
//! cancelled without consent; the next user message resumes the conversation.

use serde_json::{json, Value};

pub(crate) fn chat_handoff(method: &str, params: &Value) -> Option<String> {
    match method {
        "cursor/ask_question" => {
            let questions: Vec<Value> = params
                .get("questions")?
                .as_array()?
                .iter()
                .filter_map(|question| {
                    let prompt = question.get("prompt")?.as_str()?.trim();
                    if prompt.is_empty() {
                        return None;
                    }
                    let options: Vec<Value> = question
                        .get("options")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|option| option.get("label").and_then(Value::as_str))
                        .map(|label| json!({"label": label}))
                        .collect();
                    Some(json!({"question": prompt, "options": options}))
                })
                .collect();
            if questions.is_empty() {
                return None;
            }
            Some(format!(
                "Cursor needs your input.\nGYRO_QUESTIONS: {}\n",
                json!({"questions": questions})
            ))
        }
        "cursor/create_plan" => {
            let plan = params.get("plan")?.as_str()?.trim();
            if plan.is_empty() {
                return None;
            }
            Some(format!(
                "{plan}\n\nGYRO_QUESTIONS: {}\n",
                json!({"questions": [{
                    "question": "Proceed with this Cursor plan?",
                    "options": [{"label": "Proceed with the plan"}, {"label": "Revise the plan"}]
                }]})
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_questions_choices_and_plan_without_inventing_consent() {
        let text = chat_handoff("cursor/ask_question", &json!({"questions":[{"id":"q","prompt":"Which database?","options":[{"id":"pg","label":"Postgres"},{"id":"sqlite","label":"SQLite"}]}]})).unwrap();
        let (_, payload) = text.split_once("GYRO_QUESTIONS: ").unwrap();
        let payload: Value = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["questions"][0]["question"], "Which database?");
        assert_eq!(payload["questions"][0]["options"][1]["label"], "SQLite");
        let plan = chat_handoff(
            "cursor/create_plan",
            &json!({"plan":"1. Add cache.\n2. Test."}),
        )
        .unwrap();
        assert!(plan.starts_with("1. Add cache.\n2. Test."));
        assert!(plan.contains("Revise the plan"));
        assert!(chat_handoff("cursor/ask_question", &json!({"questions":[]})).is_none());
    }
}
