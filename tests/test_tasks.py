from werkzeug.datastructures import ImmutableMultiDict

from eNMS.tasks.models import Task

from tests.test_base import check_blueprints
from tests.test_objects import create_from_file


instant_task = ImmutableMultiDict([
    ('name', 'instant_task'),
    ('waiting_time', '0'),
    ('devices', '1'),
    ('devices', '2'),
    ('start-task', 'run-now'),
    ('job', '2'),
    ('run_immediately', 'y')
])

scheduled_task = ImmutableMultiDict([
    ('name', 'scheduled_task'),
    ('waiting_time', '0'),
    ('start-task', 'schedule'),
    ('start_date', '30/03/2018 19:10:13'),
    ('end_date', '06/04/2018 19:10:13'),
    ('frequency', '3600'),
    ('job', '2')
])


@check_blueprints('/views', '/schedule')
def test_netmiko_napalm_config(user_client):
    create_from_file(user_client, 'europe.xls')
    user_client.post('schedule/scheduler', data=instant_task)
    assert len(Task.query.all()) == 17
    user_client.post('schedule/scheduler', data=scheduled_task)
    assert len(Task.query.all()) == 18


google_earth_dict = ImmutableMultiDict([
    ('google earth', ''),
    ('name', 'test_google_earth'),
    ('label_size', '1'),
    ('line_width', '2'),
    ('netmiko_service', '')
])


# @check_blueprints('/views')
# def test_google_earth(user_client):
#     create_from_file(user_client, 'europe.xls')
#     user_client.post(
#         '/views/export_to_google_earth',
#         data=google_earth_dict
#     )
