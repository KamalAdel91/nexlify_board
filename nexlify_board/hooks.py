app_name = "nexlify_board"
app_title = "Nexlify Board"
app_publisher = "Kamal Adel"
app_description = "Configurable flow board view with transition validations"
app_email = "Kamal.adel@outlook.com"
app_license = "mit"

# Nexlify Board depends on no other app, and no app depends on it. Other apps plug in
# through data on the site: Nexlify Board Settings rows and Transition Rules.

app_include_js = [
	"nexlify_board_api.bundle.js",
	"nexlify_board_rules.bundle.js",
	"nexlify_board_fields.bundle.js",
	"nexlify_board_cards.bundle.js",
]

doctype_js = {"Kanban Board": "public/js/kanban_board_any_field.js"}

doc_events = {"*": {"validate": "nexlify_board.transition_rules.validate"}}

boot_session = "nexlify_board.board_cards.boot"
