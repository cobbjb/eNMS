from flask_login import current_user
from operator import attrgetter
from re import search, sub
from sqlalchemy import and_, Boolean, event, ForeignKey, Integer, or_
from sqlalchemy.ext.associationproxy import association_proxy
from sqlalchemy.orm import aliased, backref, relationship
from sqlalchemy.schema import UniqueConstraint
from sqlalchemy.sql.expression import false

from eNMS import app
from eNMS.models import models
from eNMS.models.base import AbstractBase
from eNMS.database import db
from eNMS.setup import properties


class Object(AbstractBase):

    __tablename__ = "object"
    pool_model = True
    type = db.Column(db.SmallString)
    __mapper_args__ = {"polymorphic_identity": "object", "polymorphic_on": type}
    id = db.Column(Integer, primary_key=True)
    creator = db.Column(db.SmallString)
    access_groups = db.Column(db.LargeString)
    last_modified = db.Column(db.TinyString, info={"log_change": False})
    subtype = db.Column(db.SmallString)
    description = db.Column(db.LargeString)
    model = db.Column(db.SmallString)
    location = db.Column(db.SmallString)
    vendor = db.Column(db.SmallString)

    def delete(self):
        number = f"{self.class_type}_number"
        for pool in self.pools:
            setattr(pool, number, getattr(pool, number) - 1)

    @classmethod
    def rbac_filter(cls, query, mode, user):
        pool_alias = aliased(models["pool"])
        return (
            query.join(cls.pools)
            .join(models["access"], models["pool"].access)
            .join(pool_alias, models["access"].user_pools)
            .join(models["user"], pool_alias.users)
            .filter(models["access"].access_type.contains(mode))
            .filter(models["user"].name == user.name)
            .group_by(cls.id)
        )


class Device(Object):

    __tablename__ = class_type = "device"
    __mapper_args__ = {"polymorphic_identity": "device"}
    parent_type = "object"
    id = db.Column(Integer, ForeignKey(Object.id), primary_key=True)
    name = db.Column(db.SmallString, unique=True)
    icon = db.Column(db.TinyString, default="router")
    operating_system = db.Column(db.SmallString)
    os_version = db.Column(db.SmallString)
    ip_address = db.Column(db.TinyString)
    longitude = db.Column(db.TinyString, default="0.0")
    latitude = db.Column(db.TinyString, default="0.0")
    port = db.Column(Integer, default=22)
    netmiko_driver = db.Column(db.TinyString, default="cisco_ios")
    napalm_driver = db.Column(db.TinyString, default="ios")
    scrapli_driver = db.Column(db.TinyString, default="cisco_iosxe")
    configuration = db.Column(db.LargeString, info={"log_change": False})
    target_services = relationship(
        "Service",
        secondary=db.service_target_device_table,
        back_populates="target_devices",
    )
    runs = relationship(
        "Run",
        secondary=db.run_device_table,
        back_populates="target_devices",
        cascade="all,delete",
    )
    tasks = relationship(
        "Task", secondary=db.task_device_table, back_populates="devices"
    )
    pools = relationship(
        "Pool", secondary=db.pool_device_table, back_populates="devices"
    )
    sessions = relationship(
        "Session", back_populates="device", cascade="all, delete-orphan"
    )

    @classmethod
    def database_init(cls):
        for property in app.configuration_properties:
            for timestamp in app.configuration_timestamps:
                setattr(
                    cls,
                    f"last_{property}_{timestamp}",
                    db.Column(db.SmallString, default="Never"),
                )
        return cls

    def get_credentials(self, credential_type="any", username=None):
        if not username:
            username = current_user.name
        pool_alias = aliased(models["pool"])
        query = (
            db.session.query(models["credential"])
            .join(models["pool"], models["credential"].user_pools)
            .join(models["user"], models["pool"].users)
            .join(pool_alias, models["credential"].device_pools)
            .join(models["device"], pool_alias.devices)
            .filter(models["user"].name == username)
            .filter(models["device"].name == self.name)
        )
        if credential_type != "any":
            query = query.filter(models["credential"].role == credential_type)
        credentials = max(query.all(), key=attrgetter("priority"), default=None)
        if not credentials:
            raise Exception(f"No matching credentials found for DEVICE '{self.name}'")
        return credentials

    def get_neighbors(self, object_type, direction="both", **link_constraints):
        filters = [models["link"].destination == self, models["link"].source == self]
        edge_constraints = (
            filters if direction == "both" else [filters[direction == "source"]]
        )
        link_constraints = [
            getattr(models["link"], key) == value
            for key, value in link_constraints.items()
        ]
        neighboring_links = (
            db.query("link")
            .filter(and_(or_(*edge_constraints), *link_constraints))
            .all()
        )
        if "link" in object_type:
            return neighboring_links
        else:
            return list(
                set(
                    link.destination if link.source == self else link.source
                    for link in neighboring_links
                )
            )

    def table_properties(self, **kwargs):
        columns = [c["data"] for c in kwargs["columns"]]
        rest_api_request = kwargs.get("rest_api_request")
        include_properties = columns if rest_api_request else None
        properties = super().get_properties(include=include_properties)
        context = int(kwargs["form"].get("context-lines", 0))
        for property in app.configuration_properties:
            if rest_api_request:
                if property in columns:
                    properties[property] = getattr(self, property)
                if f"{property}_matches" not in columns:
                    continue
            data = kwargs["form"].get(property)
            regex_match = kwargs["form"].get(f"{property}_filter") == "regex"
            if not data:
                properties[property] = ""
            else:
                result = []
                content, visited = getattr(self, property).splitlines(), set()
                for (index, line) in enumerate(content):
                    match_lines, merge = [], index - context - 1 in visited
                    if (
                        not search(data, line)
                        if regex_match
                        else data.lower() not in line.lower()
                    ):
                        continue
                    for i in range(-context, context + 1):
                        if index + i < 0 or index + i > len(content) - 1:
                            continue
                        if index + i in visited:
                            merge = True
                            continue
                        visited.add(index + i)
                        line = content[index + i].strip()
                        if rest_api_request:
                            match_lines.append(f"L{index + i + 1}: {line}")
                            continue
                        line = sub(f"(?i){data}", r"<mark>\g<0></mark>", line)
                        match_lines.append(f"<b>L{index + i + 1}:</b> {line}")
                    if rest_api_request:
                        result.extend(match_lines)
                    else:
                        if merge:
                            result[-1] += f"<br>{'<br>'.join(match_lines)}"
                        else:
                            result.append("<br>".join(match_lines))
                if rest_api_request:
                    properties[f"{property}_matches"] = result
                else:
                    properties[property] = "".join(
                        f"<pre style='text-align: left'>{match}</pre>"
                        for match in result
                    )
        return properties

    @property
    def view_properties(self):
        properties = (
            "id",
            "type",
            "name",
            "icon",
            "latitude",
            "longitude",
        )
        return {property: getattr(self, property) for property in properties}

    @property
    def ui_name(self):
        return f"{self.name} ({self.model})" if self.model else self.name

    def __repr__(self):
        return f"{self.name} ({self.model})" if self.model else self.name


class Link(Object):

    __tablename__ = class_type = "link"
    __mapper_args__ = {"polymorphic_identity": "link"}
    parent_type = "object"
    id = db.Column(Integer, ForeignKey("object.id"), primary_key=True)
    name = db.Column(db.SmallString)
    color = db.Column(db.TinyString, default="#000000")
    source_id = db.Column(Integer, ForeignKey("device.id"))
    destination_id = db.Column(Integer, ForeignKey("device.id"))
    source = relationship(
        Device,
        primaryjoin=source_id == Device.id,
        backref=backref("source", cascade="all, delete-orphan"),
    )
    source_name = association_proxy("source", "name")
    destination = relationship(
        Device,
        primaryjoin=destination_id == Device.id,
        backref=backref("destination", cascade="all, delete-orphan"),
    )
    destination_name = association_proxy("destination", "name")
    pools = relationship("Pool", secondary=db.pool_link_table, back_populates="links")
    __table_args__ = (UniqueConstraint(name, source_id, destination_id),)

    def __init__(self, **kwargs):
        self.update(**kwargs)

    @property
    def view_properties(self):
        node_properties = ("id", "longitude", "latitude")
        return {
            **{
                property: getattr(self, property)
                for property in ("id", "type", "name", "color")
            },
            **{
                f"source_{property}": getattr(self.source, property, None)
                for property in node_properties
            },
            **{
                f"destination_{property}": getattr(self.destination, property, None)
                for property in node_properties
            },
        }

    def update(self, **kwargs):
        if "source_name" in kwargs:
            kwargs["source"] = db.fetch("device", name=kwargs.pop("source_name")).id
            kwargs["destination"] = db.fetch(
                "device", name=kwargs.pop("destination_name")
            ).id
        if "source" in kwargs and "destination" in kwargs:
            kwargs.update(
                {"source_id": kwargs["source"], "destination_id": kwargs["destination"]}
            )
        super().update(**kwargs)


class Pool(AbstractBase):

    __tablename__ = type = "pool"
    models = ("device", "link", "service", "user")
    id = db.Column(Integer, primary_key=True)
    name = db.Column(db.SmallString, unique=True)
    manually_defined = db.Column(Boolean, default=False)
    creator = db.Column(db.SmallString)
    access_groups = db.Column(db.LargeString)
    admin_only = db.Column(Boolean, default=False)
    last_modified = db.Column(db.TinyString, info={"log_change": False})
    description = db.Column(db.LargeString)
    operator = db.Column(db.TinyString, default="all")
    target_services = relationship(
        "Service", secondary=db.service_target_pool_table, back_populates="target_pools"
    )
    visualization_default = db.Column(Boolean, default=False)
    runs = relationship(
        "Run", secondary=db.run_pool_table, back_populates="target_pools"
    )
    tasks = relationship("Task", secondary=db.task_pool_table, back_populates="pools")
    access_users = relationship(
        "Access", secondary=db.access_user_pools_table, back_populates="user_pools"
    )
    access = relationship(
        "Access", secondary=db.access_model_pools_table, back_populates="access_pools"
    )
    credential_devices = relationship(
        "Credential",
        secondary=db.credential_device_table,
        back_populates="device_pools",
    )
    credential_users = relationship(
        "Credential",
        secondary=db.credential_user_table,
        back_populates="user_pools",
    )

    @classmethod
    def configure_events(cls):
        for model in cls.models:

            @event.listens_for(getattr(cls, f"{model}s"), "append")
            def append(target, value, _):
                number = getattr(target, f"{value.class_type}_number") or 0
                setattr(target, f"{value.class_type}_number", number + 1)

            @event.listens_for(getattr(cls, f"{model}s"), "remove")
            def remove(target, value, _):
                number = getattr(target, f"{value.class_type}_number")
                setattr(target, f"{value.class_type}_number", number - 1)

    @classmethod
    def database_init(cls):
        for model in cls.models:
            for property in properties["filtering"][model]:
                setattr(cls, f"{model}_{property}", db.Column(db.LargeString))
                setattr(
                    cls,
                    f"{model}_{property}_match",
                    db.Column(db.TinyString, default="inclusion"),
                )
                setattr(
                    cls, f"{model}_{property}_invert", db.Column(Boolean, default=False)
                )
            setattr(
                cls,
                f"{model}s",
                relationship(
                    model.capitalize(),
                    secondary=getattr(db, f"pool_{model}_table"),
                    back_populates="pools",
                ),
            )
            setattr(cls, f"{model}_number", db.Column(Integer, default=0))

    def update(self, **kwargs):
        old_users = set(self.users)
        super().update(**kwargs)
        if not kwargs.get("import_mechanism", False):
            self.compute_pool()
            for user in set(self.users) | old_users:
                user.update_rbac()

    def property_match(self, obj, property):
        pool_value = getattr(self, f"{obj.class_type}_{property}")
        object_value = str(getattr(obj, property))
        match = getattr(self, f"{obj.class_type}_{property}_match")
        invert = getattr(self, f"{obj.class_type}_{property}_invert")
        if match == "inclusion":
            result = pool_value in object_value
        elif match == "equality":
            result = pool_value == object_value
        else:
            result = bool(search(pool_value, object_value))
        return not result if invert else result

    def object_match(self, obj):
        operator = all if self.operator == "all" else any
        return operator(
            self.property_match(obj, property)
            for property in properties["filtering"][obj.class_type]
            if getattr(self, f"{obj.class_type}_{property}")
        )

    def compute(self, model):
        return any(
            getattr(self, f"{model}_{property}")
            for property in properties["filtering"][model]
        )

    def compute_pool(self):
        for model in self.models:
            if not self.manually_defined:
                instances = (
                    list(filter(self.object_match, db.fetch_all(model)))
                    if self.compute(model)
                    else []
                )
                setattr(self, f"{model}s", instances)
            else:
                instances = getattr(self, f"{model}s")
            setattr(self, f"{model}_number", len(instances))

    @classmethod
    def rbac_filter(cls, query, mode, user):
        return query.filter(cls.admin_only == false())


class Session(AbstractBase):

    __tablename__ = type = "session"
    private = True
    id = db.Column(Integer, primary_key=True)
    name = db.Column(db.SmallString, unique=True)
    timestamp = db.Column(db.TinyString)
    user = db.Column(db.SmallString)
    content = db.Column(db.LargeString, info={"log_change": False})
    device_id = db.Column(Integer, ForeignKey("device.id"))
    device = relationship(
        "Device", back_populates="sessions", foreign_keys="Session.device_id"
    )
    device_name = association_proxy("device", "name")
