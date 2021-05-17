from json import dumps
from sqlalchemy import Boolean, ForeignKey, Integer
import xmltodict
from wtforms.widgets import TextArea

from eNMS.database import db
from eNMS.forms.automation import ConnectionForm
from eNMS.forms.fields import (
    BooleanField,
    HiddenField,
    IntegerField,
    SelectField,
    StringField,
)
from eNMS.models.automation import ConnectionService

class NetconfService(ConnectionService):
    __tablename__ = "netconf_service"
    pretty_name = "NETCONF"
    id = db.Column(
        Integer,
        ForeignKey("connection_service.id"),
        primary_key=True,
    )
    nc_type = db.Column(db.SmallString)
    target = db.Column(db.SmallString)
    default_operation = db.Column(db.SmallString)
    test_option = db.Column(db.SmallString)
    error_option = db.Column(db.SmallString)
    xml_filter = db.Column(db.LargeString, default="")
    timeout = db.Column(Integer, default=15)
    lock = db.Column(Boolean, default=False)
    unlock = db.Column(Boolean, default=False)
    commit_conf = db.Column(Boolean, default=False)
    copy_source = db.Column(db.SmallString)
    source_url = db.Column(db.SmallString)
    copy_destination = db.Column(db.SmallString)
    destination_url = db.Column(db.SmallString)
    xml_conversion = db.Column(Boolean, default=True)

    __mapper_args__ = {"polymorphic_identity": "netconf_service"}

    def job(self, run, payload, device=None):
        xml_filter = run.sub(run.xml_filter, locals())
        run.log(
            "info",
            "Sending NETCONF request",
            device,
            logger="security",
        )
        result = {
            "success": False,
            "result": "No NETCONF operation selected."
        }
        # Connect with NCClient Manager
        manager = run.ncclient_connection(device)
        # Lock target
        if run.lock:
            manager.lock(target=run.target)
        # Get full config
        if run.nc_type == "get_config":
            call =  manager.get_config(source=run.target).data_xml
            if run.xml_conversion:
                call = xmltodict.parse(str(call))
        # Filtered get
        if run.nc_type == "get_filtered_config":
            call = manager.get(str(xml_filter)).data_xml
            if run.xml_conversion:
                call = xmltodict.parse(str(call))
        # Push Config
        if run.nc_type == "push_config":
            if run.default_operation == "None":
                default_operation = None
            else:
                default_operation = run.default_operation
            if run.test_option == "None":
                test_option = None
            else:
                test_option = run.test_option
            if run.error_option == "None":
                error_option = None
            else:
                error_option = run.error_option
            call = manager.edit_config(
                target=run.target,
                config=str(xml_filter),
                default_operation=default_operation,
                test_option=test_option,
                error_option=error_option,
            )
            if run.commit_conf:
                manager.commit()
            if run.xml_conversion:
                call = xmltodict.parse(str(call))
        # Copy config
        if run.nc_type == "copy_config":
            if run.copy_source == "source_url":
                cpsource = run.source_url
            else:
                cpsource = run.copy_source
            if run.copy_destination == "destination_url":
                cptarget = run.destination_url
            else:
                cptarget = run.copy_destination
            call = manager.copy_config(source=cpsource, target=cptarget)
            if run.xml_conversion:
                result = xmltodict.parse(str(call))
            if run.commit_conf:
                manager.commit()
        # Remote Procedure Call
        if run.nc_type == "rpc":
            call = manager.rpc(str(xml_filter)).data_xml
            if run.xml_conversion:
                call = xmltodict.parse(str(call))
        # Unlock target
        if run.unlock:
            manager.unlock(target=run.target)
        result = {
            "success": True,
            "result": call
        }
        return result
# Form fields
class Form:

    netconf_type = {
        "get_config": ["target", "xml_conversion"],
        "get_filtered_config": [
            "target",
            "xml_filter",
            "xml_conversion",
        ],
        "push_config": [
            "target",
            "xml_filter",
            "default_operation",
            "test_option",
            "error_option",
            "lock",
            "unlock",
            "commit_conf",
            "xml_conversion",
        ],
        "copy_config": [
            "copy_source",
            "source_url",
            "copy_destination",
            "destination_url",
            "commit_conf",
            "xml_conversion",
        ],
        "rpc": ["xml_filter", "xml_conversion"],
    }
    def form_init():
        list_parameters = list(set(sum(Form.netconf_type.values(), [])))
        return list_parameters
    def opts():
        options = ["nc_type"] + list(set(sum(Form.netconf_type.values(), [])))
        return options

# WTForms class
class NetconfForm(ConnectionForm):
    form_type = HiddenField(default="netconf_service")
    nc_type = SelectField(
        choices=(
            ("get_config", "Get Full Config"),
            ("get_filtered_config", "Get Filtered Config"),
            ("push_config", "Edit Config"),
            ("copy_config", "Copy Config"),
            ("rpc", "Remote Procedure Call"),
        ),
        label="NETCONF Operation",
    )
    xml_filter = StringField(
        label="XML Filter",
        widget=TextArea(),
        render_kw={"rows": 5},
        substitution=True,
    )
    target = SelectField(
        choices=(
            ("running", "Running"),
            ("candidate", "Candidate"),
            ("startup", "Startup"),
        ),
        label="Target Config",
    )
    default_operation = SelectField(
        choices=(
            ("merge", "Merge"),
            ("replace", "Replace"),
            ("None", "None"),
        ),
        label="Default config operation",
        validate_choice=False,
    )
    test_option = SelectField(
        choices=(
            ("test-then-set", "Test, then set"),
            ("set", "Set"),
            ("None", "None"),
        ),
        label="Config test option",
        validate_choice=False,
    )
    error_option = SelectField(
        choices=(
            ("stop-on-error", "Stop on error"),
            ("continue-on-error", "Continue on error"),
            ("rollback-on-error", "Rollback on error"),
            ("None", "None"),
        ),
        label="Error option",
        validate_choice=False,
    )
    lock = BooleanField(label="Lock target")
    unlock = BooleanField(label="Unlock target")
    copy_source = SelectField(
        choices=(
            ("running", "Running"),
            ("candidate", "Candidate"),
            ("startup", "Startup"),
            ("source_url", "Source URL"),
        ),
        label="Copy Source",
        validate_choice=False,
    )
    source_url = StringField(
        label="Copy source URL",
        widget=TextArea(),
        render_kw={"rows": 1},
        substitution=True,
    )
    copy_destination = SelectField(
        choices=(
            ("running", "Running"),
            ("candidate", "Candidate"),
            ("startup", "Startup"),
            ("destination_url", "Destination URL"),
        ),
        label="Copy Destination",
        validate_choice=False,
    )
    destination_url = StringField(
        label="Copy destination URL",
        widget=TextArea(),
        render_kw={"rows": 1},
        substitution=True,
    )
    commit_conf = BooleanField(label="Commit")
    timeout = IntegerField(default=15)
    xml_conversion = BooleanField(
        label="Convert XML result to dictionary", default=True
    )
    groups = {
        "NETCONF Parameters": {
             "commands": Form.opts(),
             "default": "expanded",
        },
        **ConnectionForm.groups,
    }
    # this hidden field is used to pass information to javascript so the field
    # visibility can be changed as set below
    input_data = HiddenField(
        "",
        default=dumps(
            {
                # add all fields to the field list except for "nc_type"
                # which will drive the selection
                # every field in this list will be hidden unless it is
                # contained in one of the netconf type entries below.
                "fields": Form.form_init(),
                # add all the different netconf commands as keys with the list
                # of fields to be shown for the particular command
                "netconf_type": Form.netconf_type,
            }
        ),
    )